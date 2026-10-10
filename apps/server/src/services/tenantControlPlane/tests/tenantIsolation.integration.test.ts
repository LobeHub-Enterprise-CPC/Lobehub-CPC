// @vitest-environment node
/**
 * Tenant isolation on a real PostgreSQL (spec FS-04, FS-06; AC-04-1..5,
 * AC-06-5). Runs only when DATABASE_TEST_URL points at a server where the
 * connecting role may create databases and roles; otherwise skipped.
 *
 * Console's provisioning function is emulated by the superuser setup below:
 * schema `tenant_<h24>` owned by `lh_<h24>_owner`, runtime `lh_<h24>_run`
 * with USAGE only. Everything after that is LobeHub code: the provision
 * executor, the Postgres control-plane repository and the tenant runtime.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as platformSchema from '@lobechat/database/platform';
import {
  runTenantMigrations,
  runWithTenantScope,
  tenantDB,
  tenantDbNames,
  tenantDrainLockKey,
  type TenantMigrator,
  TenantPoolManager,
} from '@lobechat/database/tenant';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantClaims } from '@/server/modules/Tenant/claims';
import { tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import { TENANT_ADMISSION_TTL_MS, TenantRuntime } from '@/server/modules/Tenant/runtime';

import type { DatasourceBundle } from '../contracts';
import { PostgresTenantDatabaseExecutor } from '../postgresExecutor';
import { PostgresControlPlaneRepository } from '../postgresRepository';
import { TenantControlPlaneService } from '../service';
import { upgradeTenantSchemas } from '../upgrade';

// This suite isolates tenant SQL/roles/drain; durable cross-process receipts are
// exercised against real workers in Tenant/tests/claims.postgres.test.ts.
const releases: (() => Promise<void>)[] = [];
const testRuntime = (...args: ConstructorParameters<typeof TenantRuntime>) =>
  new TenantRuntime(
    args[0],
    args[1],
    args[2],
    new TenantClaims({ acquire: async () => {}, release: async () => {} }),
  );
const admitScope = async (runtime: TenantRuntime, slug: string) => {
  const work = await runtime.enterSlug(slug);
  releases.push(work.release);
  return work.scope;
};

const ADMIN_URL = process.env.DATABASE_TEST_URL;
const suite = ADMIN_URL ? describe : describe.skip;

const DB_NAME = `lh_tenant_it_${process.pid}_${Date.now() % 100_000}`;
const TENANTS = [
  { id: `it-tenant-a-${process.pid}`, slug: 'acme' },
  { id: `it-tenant-b-${process.pid}`, slug: 'beta' },
];

/** A two-file chain written for `public`, like the real one. */
const fixtureChain = () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'tenant-chain-'));
  mkdirSync(path.join(folder, 'meta'));
  writeFileSync(
    path.join(folder, '0000_base.sql'),
    [
      `CREATE TABLE "public"."users" ("id" text PRIMARY KEY NOT NULL, "email" text);`,
      `CREATE TABLE "public"."tenant_metadata" ("tenant_id" text PRIMARY KEY NOT NULL, "datasource_kind" text NOT NULL, "schema_version" text NOT NULL, "installed_at" timestamp with time zone DEFAULT now() NOT NULL);`,
    ].join('--> statement-breakpoint\n'),
  );
  writeFileSync(
    path.join(folder, '0001_notes.sql'),
    `CREATE TABLE "public"."notes" ("id" text PRIMARY KEY NOT NULL, "user_id" text NOT NULL REFERENCES "public"."users"("id"));`,
  );
  writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({
      dialect: 'postgresql',
      entries: [
        { breakpoints: true, idx: 0, tag: '0000_base', version: '7', when: 1_700_000_000_000 },
        { breakpoints: true, idx: 1, tag: '0001_notes', version: '7', when: 1_700_000_000_001 },
      ],
      version: '7',
    }),
  );
  return folder;
};

const dbUrl = (base: string, database: string, user?: string, password?: string) => {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = password ?? '';
  }
  return url.toString();
};

suite('tenant isolation on PostgreSQL', () => {
  let admin: Client;
  let platformPool: Pool;
  let runtime: TenantRuntime;
  let service: TenantControlPlaneService;
  let executor: PostgresTenantDatabaseExecutor;
  let platformDB: ReturnType<typeof drizzle<typeof platformSchema>>;
  let chainFolder: string;
  const bundles = new Map<string, DatasourceBundle>();
  const previousSecret = process.env.KEY_VAULTS_SECRET;

  beforeAll(async () => {
    process.env.KEY_VAULTS_SECRET = 'integration-master-secret';
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE "${DB_NAME}"`);
    await root.end();

    admin = new Client({ connectionString: dbUrl(ADMIN_URL!, DB_NAME) });
    await admin.connect();
    await admin.query(`REVOKE CONNECT ON DATABASE "${DB_NAME}" FROM PUBLIC`);
    await admin.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC`);
    await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions`);
    await admin.query(`CREATE SCHEMA IF NOT EXISTS paradedb`);
    // Like Console's baseline, leave tenant roles nothing outside their schema
    // and the extension schemas, whatever else the image's template installs.
    const { rows: otherSchemas } = await admin.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%'
          AND nspname NOT IN ('information_schema', 'public', 'extensions', 'paradedb', 'pdb')`,
    );
    for (const { nspname } of otherSchemas)
      await admin.query(`REVOKE ALL ON SCHEMA "${nspname}" FROM PUBLIC`);
    await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`);

    const url = new URL(ADMIN_URL!);
    for (const tenant of TENANTS) {
      const names = tenantDbNames(tenant.id);
      for (const role of [names.ownerUsername, names.runtimeUsername]) {
        await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
        await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${role}-pw'`);
        await admin.query(`GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${role}"`);
        await admin.query(`GRANT USAGE ON SCHEMA extensions, paradedb TO "${role}"`);
      }
      await admin.query(
        `CREATE SCHEMA "${names.schemaName}" AUTHORIZATION "${names.ownerUsername}"`,
      );
      await admin.query(`REVOKE ALL ON SCHEMA "${names.schemaName}" FROM PUBLIC`);
      await admin.query(
        `GRANT USAGE ON SCHEMA "${names.schemaName}" TO "${names.runtimeUsername}"`,
      );
      bundles.set(tenant.id, {
        connectionVersion: 1,
        credentialBundleVersion: 1,
        database: DB_NAME,
        datasourceKind: 'lobehub',
        deploymentRef: 'default',
        host: url.hostname,
        mode: 'shared_schema',
        port: Number(url.port || 5432),
        runtimeCredential: {
          password: `${names.runtimeUsername}-pw`,
          username: names.runtimeUsername,
        },
        schemaName: names.schemaName,
        schemaOwner: {
          password: `${names.ownerUsername}-pw`,
          role: names.ownerUsername,
          username: names.ownerUsername,
        },
        schemaVersion: 1,
        tenantId: tenant.id,
        tls: { enabled: false, rejectUnauthorized: false },
      });
    }

    // The platform database is the same database's `public` here.
    platformPool = new Pool({ connectionString: dbUrl(ADMIN_URL!, DB_NAME) });
    platformDB = drizzle(platformPool, { schema: platformSchema });
    await migrate(platformDB, {
      migrationsFolder: path.join(process.cwd(), 'packages/database/migrations/platform'),
    });

    await platformDB.insert(platformSchema.tenantRuntimeCutover).values({
      id: 'strict-stop',
      enforcedAt: new Date(),
      evidence: 'isolated SQL fixture; no legacy replicas',
      buildRef: 'test',
    });

    chainFolder = fixtureChain();
    const fixture: TenantMigrator = {
      journalTables: ['__drizzle_migrations'],
      name: 'fixture',
      run: (client, ctx) => runTenantMigrations(client, chainFolder, ctx),
    };
    executor = new PostgresTenantDatabaseExecutor({ migrators: () => [fixture] });
    service = new TenantControlPlaneService({
      database: executor,
      isRegistrableSlug: () => true,
      repository: new PostgresControlPlaneRepository(platformDB),
    });
    runtime = testRuntime(() => platformDB, new TenantPoolManager({ maxPools: 4 }));
  }, 60_000);

  afterAll(async () => {
    process.env.KEY_VAULTS_SECRET = previousSecret;
    await Promise.all(releases.splice(0).map((release) => release()));
    await platformPool?.end();
    await admin?.end();
    if (!ADMIN_URL) return;
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    for (const tenant of TENANTS) {
      const names = tenantDbNames(tenant.id);
      await root.query(`DROP ROLE IF EXISTS "${names.ownerUsername}"`).catch(() => undefined);
      await root.query(`DROP ROLE IF EXISTS "${names.runtimeUsername}"`).catch(() => undefined);
    }
    await root.end();
  }, 60_000);

  it('refuses a bundle whose owner does not own the schema, before any migration (AC-06-5)', async () => {
    const [a, b] = TENANTS;
    const bundle = { ...bundles.get(a.id)!, schemaOwner: bundles.get(b.id)!.schemaOwner };
    await expect(
      executor.checkOwnership({
        bundle,
        name: 'A',
        operationId: 'x',
        slug: a.slug,
        tenantId: a.id,
      }),
    ).rejects.toThrow();
  });

  it('provisions both tenants end to end and opens them on an active event', async () => {
    for (const tenant of TENANTS) {
      const received = await service.receiveProvision({
        datasource: bundles.get(tenant.id)!,
        name: tenant.slug,
        operationId: `root-${tenant.slug}:lobehub`,
        rootOperationId: `root-${tenant.slug}`,
        slug: tenant.slug,
        tenantId: tenant.id,
      });
      expect(received.status).toBe('received');
      const applied = await service.executeProvision(tenant.id, `root-${tenant.slug}:lobehub`);
      expect(applied).toMatchObject({ datasourceReady: true, errorCode: null, status: 'applied' });

      // Not open for business until Console activates it.
      await expect(admitScope(runtime, tenant.slug)).rejects.toMatchObject({
        code: 'TENANT_NOT_READY',
      });

      await service.receiveLifecycle({
        desiredState: 'active',
        eventId: `evt-${tenant.slug}`,
        expiresAt: null,
        freezeReasons: [],
        occurredAt: new Date().toISOString(),
        tenantId: tenant.id,
        version: 1,
      });
      runtime.invalidate(tenant.id);
      await expect(admitScope(runtime, tenant.slug)).resolves.toMatchObject({
        tenantId: tenant.id,
      });
    }

    // Re-running a finished provision changes nothing (AC-06-2 idempotency).
    await expect(
      executor.migrate({
        bundle: bundles.get(TENANTS[0].id)!,
        name: 'acme',
        operationId: 'again',
        slug: 'acme',
        tenantId: TENANTS[0].id,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('keeps the same ids apart per tenant (AC-04-1)', async () => {
    for (const tenant of TENANTS) {
      const scope = await admitScope(runtime, tenant.slug);
      await runWithTenantScope(scope, () =>
        tenantDB.execute(sql`INSERT INTO users (id, email) VALUES ('same-id', ${tenant.slug})`),
      );
    }
    for (const tenant of TENANTS) {
      const scope = await admitScope(runtime, tenant.slug);
      const rows = await runWithTenantScope(scope, () =>
        tenantDB.execute<{ email: string }>(sql`SELECT email FROM users`),
      );
      expect(rows.rows).toEqual([{ email: tenant.slug }]);
    }
  });

  it("denies the runtime role another tenant's schema, the owner role and public (AC-04-2, AC-04-3)", async () => {
    const [a, b] = TENANTS;
    const scope = await admitScope(runtime, a.slug);
    const other = tenantDbNames(b.id).schemaName;
    await expect(
      runWithTenantScope(scope, () => tenantDB.execute(sql.raw(`SELECT * FROM "${other}".users`))),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(
      runWithTenantScope(scope, () =>
        tenantDB.execute(sql.raw(`SELECT * FROM public.tenant_directory`)),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(
      runWithTenantScope(scope, () =>
        tenantDB.execute(sql.raw(`SET ROLE "${tenantDbNames(a.id).ownerUsername}"`)),
      ),
    ).rejects.toBeDefined();
    await expect(
      runWithTenantScope(scope, () =>
        tenantDB.execute(
          sql.raw(
            `INSERT INTO tenant_metadata (tenant_id, datasource_kind, schema_version) VALUES ('x', 'lobehub', '1')`,
          ),
        ),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  it("refuses another tenant's credentials through the marker check (AC-04-4)", async () => {
    const [a, b] = TENANTS;
    await expect(executor.verify({ bundle: bundles.get(b.id)!, tenantId: a.id })).rejects.toThrow();
  });

  it('fails without a tenant scope instead of using any other connection (AC-04-5)', async () => {
    expect(() => tenantDB.execute(sql`SELECT 1`)).toThrow('TENANT_REQUIRED');
    await expect(admitScope(runtime, 'missing')).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });

  it('refuses a frozen tenant at the gate as soon as the event is received (AC-05-4 style)', async () => {
    const [a, b] = TENANTS;
    await service.receiveLifecycle({
      desiredState: 'frozen',
      eventId: 'evt-freeze-a',
      expiresAt: null,
      freezeReasons: ['manual'],
      occurredAt: new Date().toISOString(),
      tenantId: a.id,
      version: 2,
    });
    runtime.invalidate(a.id);
    await expect(admitScope(runtime, a.slug)).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
    await expect(admitScope(runtime, b.slug)).resolves.toMatchObject({ tenantId: b.id });
  });

  it('upgrades every active tenant on deploy and reruns one tenant on request (FR-MD-02)', async () => {
    // A new release adds a migration to the chain.
    writeFileSync(
      path.join(chainFolder, '0002_tags.sql'),
      `CREATE TABLE "public"."tags" ("id" text PRIMARY KEY NOT NULL);`,
    );
    const journalPath = path.join(chainFolder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries.push({
      breakpoints: true,
      idx: 2,
      tag: '0002_tags',
      version: '7',
      when: 1_700_000_000_002,
    });
    writeFileSync(journalPath, JSON.stringify(journal));

    const all = await upgradeTenantSchemas(platformDB, { executor });
    expect(all.failed).toEqual([]);
    expect(all.migrated.sort()).toEqual(TENANTS.map((t) => t.id).sort());

    for (const tenant of TENANTS) {
      const { schemaName } = tenantDbNames(tenant.id);
      const { rows } = await admin.query(`SELECT to_regclass($1) AS t`, [`${schemaName}.tags`]);
      expect(rows[0].t).not.toBeNull();
    }

    const [a] = TENANTS;
    const one = await upgradeTenantSchemas(platformDB, { executor, tenantIds: [a.id, 'missing'] });
    expect(one).toEqual({
      failed: [{ reason: 'NOT_FOUND', tenantId: 'missing' }],
      migrated: [a.id],
    });
  });

  it('stops work admitted before a freeze and resumes it after reactivation (FR-DI-07)', async () => {
    const [, b] = TENANTS;
    // A second process: it never sees this process's invalidate(), only the
    // platform database and the propagation window.
    let clock = Date.now();
    const remote = testRuntime(
      () => platformDB,
      new TenantPoolManager({ maxPools: 2 }),
      () => new Date(clock),
    );
    // A long request or queued step admitted while the tenant was active.
    const scope = await admitScope(remote, b.slug);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inFlightStarted!: () => void;
    const started = new Promise<void>((resolve) => (inFlightStarted = resolve));
    const inFlight = runWithTenantScope(scope, () =>
      tenantDB.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO users (id, email) VALUES ('in-flight', 'b')`);
        inFlightStarted();
        await held;
      }),
    );
    await started;

    await service.receiveLifecycle({
      desiredState: 'frozen',
      eventId: 'evt-freeze-b',
      expiresAt: null,
      freezeReasons: ['manual'],
      occurredAt: new Date().toISOString(),
      tenantId: b.id,
      version: 2,
    });

    // The drain waits for the transaction that was already running.
    let drained = false;
    const drain = runtime.drainTransactions(b.id, 10_000).then(() => (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(drained).toBe(false);
    release();
    await inFlight;
    await drain;

    // Once its admission cache is older than the propagation window, the
    // remote process refuses new work through the scope it admitted earlier.
    clock += TENANT_ADMISSION_TTL_MS + 1;
    const frozen = (error: unknown) => tenantGateErrorOf(error)?.code === 'TENANT_FROZEN';
    await expect(
      runWithTenantScope(scope, () => tenantDB.execute(sql`SELECT 1`)),
    ).rejects.toSatisfy(frozen);
    await expect(
      runWithTenantScope(scope, () =>
        tenantDB.transaction((tx) => tx.execute(sql`INSERT INTO users (id) VALUES ('late')`)),
      ),
    ).rejects.toSatisfy(frozen);

    await service.receiveLifecycle({
      desiredState: 'active',
      eventId: 'evt-resume-b',
      expiresAt: null,
      freezeReasons: [],
      occurredAt: new Date().toISOString(),
      tenantId: b.id,
      version: 3,
    });
    clock += TENANT_ADMISSION_TTL_MS + 1;
    const rows = await runWithTenantScope(scope, () =>
      tenantDB.execute<{ id: string }>(sql`SELECT id FROM users WHERE id IN ('in-flight', 'late')`),
    );
    expect(rows.rows).toEqual([{ id: 'in-flight' }]);
  });

  it('re-checks admission after a transaction waited for its connection or the drain lock', async () => {
    const [, b] = TENANTS;
    let clock = Date.now();
    // One connection per pool, so a second transaction waits for the first.
    const remote = testRuntime(
      () => platformDB,
      new TenantPoolManager({ maxConnectionsPerPool: 1, maxPools: 2 }),
      () => new Date(clock),
    );
    const scope = await admitScope(remote, b.slug);
    const frozen = (error: unknown) => tenantGateErrorOf(error)?.code === 'TENANT_FROZEN';
    const insert = (id: string) =>
      runWithTenantScope(scope, () =>
        tenantDB.transaction((tx) => tx.execute(sql`INSERT INTO users (id) VALUES (${id})`)),
      );

    // 1. Waiting for the drain lock: a drain holds it exclusively.
    const lockKey = tenantDrainLockKey(b.id);
    await admin.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    const waitingForLock = insert('after-drain-lock');
    // Let it pass the admission check, connect and block on the shared lock.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 2. Waiting for a pooled connection held by the blocked transaction:
    // one Drizzle transaction and one standalone statement.
    const waitingForConnection = insert('after-pool-wait');
    const standaloneWaiting = runWithTenantScope(scope, () =>
      tenantDB.execute(sql`INSERT INTO users (id) VALUES ('after-pool-wait-standalone')`),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    await service.receiveLifecycle({
      desiredState: 'frozen',
      eventId: 'evt-freeze-b-2',
      expiresAt: null,
      freezeReasons: ['manual'],
      occurredAt: new Date().toISOString(),
      tenantId: b.id,
      version: 4,
    });
    clock += TENANT_ADMISSION_TTL_MS + 1;
    await admin.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);

    await expect(waitingForLock).rejects.toSatisfy(frozen);
    await expect(waitingForConnection).rejects.toSatisfy(frozen);
    await expect(standaloneWaiting).rejects.toSatisfy(frozen);

    await service.receiveLifecycle({
      desiredState: 'active',
      eventId: 'evt-resume-b-2',
      expiresAt: null,
      freezeReasons: [],
      occurredAt: new Date().toISOString(),
      tenantId: b.id,
      version: 5,
    });
    clock += TENANT_ADMISSION_TTL_MS + 1;
    // Neither refusal leaked the single pooled connection or an open transaction.
    for (const id of ['resumed-1', 'resumed-2']) await insert(id);
    await runWithTenantScope(scope, () =>
      tenantDB.execute(sql`INSERT INTO users (id) VALUES ('resumed-3')`),
    );
    const rows = await runWithTenantScope(scope, () =>
      tenantDB.execute<{ id: string }>(
        sql`SELECT id FROM users WHERE id IN ('after-drain-lock', 'after-pool-wait', 'after-pool-wait-standalone', 'resumed-1', 'resumed-2', 'resumed-3') ORDER BY id`,
      ),
    );
    expect(rows.rows.map((row) => row.id)).toEqual(['resumed-1', 'resumed-2', 'resumed-3']);
  }, 30_000);
});
