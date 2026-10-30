// @vitest-environment node
/**
 * Tenant isolation on a real PostgreSQL (spec FS-04, FS-06; AC-04-1..5,
 * AC-06-5). Runs only when DATABASE_TEST_URL points at a server where the
 * connecting role may create databases and roles; otherwise skipped.
 *
 * Console's provisioning function is emulated by the superuser setup below:
 * schema `tenant_<h24>` owned by `titu_<h24>_owner`, runtime `titu_<h24>_run`
 * with USAGE only. Everything after that is LobeHub code: the provision
 * executor, the Postgres control-plane repository and the tenant runtime.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
  verifyTenantMigrationHistory,
} from '@lobechat/database/tenant';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import type { TenantRuntime } from '@/server/modules/Tenant/runtime';
import { TENANT_ADMISSION_TTL_MS } from '@/server/modules/Tenant/runtime';

import { ACCOUNT_LOOKUP_ROLE } from '../../tenantDiscovery/permissions';
import type { DatasourceBundle } from '../contracts';
import { PostgresTenantDatabaseExecutor } from '../postgresExecutor';
import { PostgresControlPlaneRepository } from '../postgresRepository';
import type { LifecycleEventRecord, ProvisionOperationRecord } from '../repository';
import { TenantControlPlaneService } from '../service';
import { upgradeTenantSchemas } from '../upgrade';
import {
  createIsolationTestRuntime,
  DB_NAME,
  dbUrl,
  fixtureChain,
  prepareIsolationSchemas,
  TENANTS,
} from './tenantIsolation.testUtils';

let fixtureMigrators: TenantMigrator[];
const { releases, testRuntime, admitScope } = createIsolationTestRuntime(() => fixtureMigrators);

const ADMIN_URL = process.env.DATABASE_TEST_URL;
const suite = ADMIN_URL ? describe : describe.skip;

suite('tenant isolation on PostgreSQL', () => {
  let admin: Client;
  let createdLookupRole = false;
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
    await root.query(`CREATE DATABASE "${DB_NAME}" TEMPLATE template0`);
    await root.end();

    admin = new Client({ connectionString: dbUrl(ADMIN_URL!, DB_NAME) });
    await admin.connect();
    await prepareIsolationSchemas(admin);

    const lookup = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [
      ACCOUNT_LOOKUP_ROLE,
    ]);
    if (!lookup.rowCount) {
      if (process.env.TEST_ACCOUNT_LOOKUP_ISOLATED_CLUSTER !== '1')
        throw new Error(
          'Initialize the account lookup role first, or use an explicitly isolated test cluster',
        );
      await admin.query(
        `CREATE ROLE "${ACCOUNT_LOOKUP_ROLE}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
      );
      createdLookupRole = true;
    }
    await admin.query(`GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${ACCOUNT_LOOKUP_ROLE}"`);
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

    chainFolder = fixtureChain();
    const fixture: TenantMigrator = {
      journalTables: ['__drizzle_migrations'],
      name: 'fixture',
      verify: async (client, ctx, allowPending) => {
        await verifyTenantMigrationHistory(client, chainFolder, { ...ctx, allowPending });
        if (!allowPending) await client.query(`SELECT id FROM "${ctx.schemaName}".users LIMIT 0`);
      },
      run: (client, ctx) => runTenantMigrations(client, chainFolder, ctx),
    };
    fixtureMigrators = [fixture];
    executor = new PostgresTenantDatabaseExecutor({ migrators: () => fixtureMigrators });
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
    if (createdLookupRole) await root.query(`DROP ROLE "${ACCOUNT_LOOKUP_ROLE}"`);
    await root.end();
  }, 60_000);

  it.each(['operation', 'event'] as const)(
    'never reassigns a global %s ID during cross-tenant concurrent inserts',
    async (kind) => {
      const repository = new PostgresControlPlaneRepository(platformDB);
      const ready = Promise.withResolvers<void>();
      let arrivals = 0;
      const id = `global-race-${kind}`;
      const tenants = ['race-tenant-a', 'race-tenant-b'];
      const outcomes = await Promise.allSettled(
        tenants.map((tenantId) =>
          repository.transaction(tenantId, async (tx) => {
            expect(await (kind === 'operation' ? tx.getOperation(id) : tx.getEvent(id))).toBeNull();
            if (++arrivals === 2) ready.resolve();
            await ready.promise;
            if (kind === 'operation')
              await tx.putOperation({
                attempts: 0,
                credentialBundleVersion: null,
                datasourceReady: false,
                errorCode: null,
                inputHash: tenantId,
                name: tenantId,
                operationId: id,
                schemaName: null,
                schemaVersion: null,
                slug: tenantId,
                status: 'received',
                step: 'ownership',
                tenantId,
              } satisfies ProvisionOperationRecord);
            else
              await tx.putEvent({
                attempts: 0,
                errorCode: null,
                eventId: id,
                observedAt: new Date().toISOString(),
                payloadHash: tenantId,
                status: 'received',
                tenantId,
                version: 1,
                request: {
                  desiredState: 'active',
                  eventId: id,
                  expiresAt: null,
                  freezeReasons: [],
                  occurredAt: new Date().toISOString(),
                  tenantId,
                  version: 1,
                },
              } satisfies LifecycleEventRecord);
            return tenantId;
          }),
        ),
      );
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const winner = outcomes.find((result) => result.status === 'fulfilled');
      const saved = await repository.transaction(tenants[0], (tx) =>
        kind === 'operation' ? tx.getOperation(id) : tx.getEvent(id),
      );
      expect(saved?.tenantId).toBe(winner?.status === 'fulfilled' ? winner.value : undefined);
      const loser = outcomes.find((result) => result.status === 'rejected');
      expect(loser?.status === 'rejected' && loser.reason).toMatchObject({ status: 409 });
    },
  );

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

  it.skipIf(process.env.TEST_ACCOUNT_LOOKUP_ISOLATED_CLUSTER !== '1')(
    'keeps runtime verification independent from missing lookup role or column grants',
    async () => {
      const tenant = TENANTS[0];
      const bundle = bundles.get(tenant.id)!;
      await admin.query(
        `REVOKE SELECT (email) ON "${bundle.schemaName}".users FROM "${ACCOUNT_LOOKUP_ROLE}"`,
      );
      try {
        await expect(executor.verify({ bundle, tenantId: tenant.id })).resolves.toBeUndefined();
        await expect(executor.verifyDiscovery({ bundle, tenantId: tenant.id })).rejects.toThrow(
          'USERS_COLUMN',
        );
      } finally {
        await admin.query(
          `GRANT SELECT (email) ON "${bundle.schemaName}".users TO "${ACCOUNT_LOOKUP_ROLE}"`,
        );
      }
      const hidden = `lookup_hidden_${process.pid}`;
      await admin.query(`ALTER ROLE "${ACCOUNT_LOOKUP_ROLE}" RENAME TO "${hidden}"`);
      try {
        await expect(executor.verify({ bundle, tenantId: tenant.id })).resolves.toBeUndefined();
        await expect(
          executor.verifyDiscovery({ bundle, tenantId: tenant.id }),
        ).rejects.toBeDefined();
      } finally {
        await admin.query(`ALTER ROLE "${hidden}" RENAME TO "${ACCOUNT_LOOKUP_ROLE}"`);
      }
    },
  );

  it('accepts inaccessible public relations while verifying tenant sequence permissions', async () => {
    const tenant = TENANTS[0];
    await admin.query(
      'CREATE TABLE public.readiness_planner_table(id int); CREATE VIEW public.readiness_planner_view AS SELECT id FROM public.readiness_planner_table; CREATE SEQUENCE public.readiness_planner_sequence',
    );
    try {
      await expect(
        executor.verify({ tenantId: tenant.id, bundle: bundles.get(tenant.id)! }),
      ).resolves.toBeUndefined();
    } finally {
      await admin.query(
        'DROP VIEW public.readiness_planner_view; DROP TABLE public.readiness_planner_table; DROP SEQUENCE public.readiness_planner_sequence',
      );
    }
  });

  it('records an extra PUBLIC schema refusal and clears the current diagnostic after repair', async () => {
    const tenant = TENANTS[0];
    const operationId = `root-${tenant.slug}:lobehub`;
    const repository = new PostgresControlPlaneRepository(platformDB);
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await admin.query('GRANT USAGE ON SCHEMA pgivm TO PUBLIC');
    try {
      await repository.transaction(tenant.id, async (tx) => {
        const op = (await tx.getOperation(operationId))!;
        await tx.putOperation({ ...op, status: 'received', step: 'verify' });
        await tx.putOperationBundle(operationId, bundles.get(tenant.id)!);
      });
      const failed = await service.executeProvision(tenant.id, operationId);
      expect(failed).toMatchObject({
        errorCode: 'DATASOURCE_INVALID',
        diagnosticCode: 'CROSS_SCHEMA_USAGE',
        status: 'failed',
      });
      expect(await service.getProvision(tenant.id, operationId)).toMatchObject({
        diagnosticCode: 'CROSS_SCHEMA_USAGE',
      });
      expect(JSON.stringify(logged.mock.calls)).toContain('CROSS_SCHEMA_USAGE');
      process.stdout.write(
        JSON.stringify({
          evidence: 'safe_template_diagnostic',
          result: {
            diagnosticCode: failed.diagnosticCode,
            errorCode: failed.errorCode,
            status: failed.status,
          },
          serviceLog: JSON.parse(logged.mock.calls.at(-1)![0]),
        }) + '\n',
      );
      expect(JSON.stringify([failed, logged.mock.calls])).not.toContain('-pw');
    } finally {
      await admin.query('REVOKE USAGE ON SCHEMA pgivm FROM PUBLIC');
      logged.mockRestore();
      await service.receiveProvision({
        datasource: bundles.get(tenant.id)!,
        name: tenant.slug,
        operationId,
        rootOperationId: `root-${tenant.slug}`,
        slug: tenant.slug,
        tenantId: tenant.id,
      });
      expect(await service.executeProvision(tenant.id, operationId)).toMatchObject({
        status: 'applied',
        diagnosticCode: null,
      });
    }
  });

  it.each(['sequence', 'foreign table', 'truncate-only table', 'shared extension schema'] as const)(
    'refuses public %s access without public schema USAGE',
    async (kind) => {
      const tenant = TENANTS[0];
      const { runtimeUsername } = tenantDbNames(tenant.id);
      let cleanup: string;
      if (kind === 'shared extension schema') {
        await admin.query(`GRANT CREATE ON SCHEMA extensions TO "${runtimeUsername}"`);
        cleanup = `REVOKE CREATE ON SCHEMA extensions FROM "${runtimeUsername}"`;
      } else if (kind === 'sequence') {
        await admin.query(
          `CREATE SEQUENCE public.diagnostic_sequence; GRANT USAGE ON SEQUENCE public.diagnostic_sequence TO "${runtimeUsername}"`,
        );
        cleanup = 'DROP SEQUENCE public.diagnostic_sequence';
      } else if (kind === 'foreign table') {
        await admin.query(
          `CREATE EXTENSION IF NOT EXISTS postgres_fdw; CREATE SERVER diagnostic_fdw FOREIGN DATA WRAPPER postgres_fdw OPTIONS(host '127.0.0.1', dbname 'unused'); CREATE FOREIGN TABLE public.diagnostic_foreign(id int) SERVER diagnostic_fdw; GRANT SELECT ON public.diagnostic_foreign TO "${runtimeUsername}"`,
        );
        cleanup = 'DROP FOREIGN TABLE public.diagnostic_foreign; DROP SERVER diagnostic_fdw';
      } else {
        await admin.query(
          `CREATE TABLE public.diagnostic_table(id int); GRANT TRUNCATE ON public.diagnostic_table TO "${runtimeUsername}"`,
        );
        cleanup = 'DROP TABLE public.diagnostic_table';
      }
      try {
        await expect(
          executor.verify({ tenantId: tenant.id, bundle: bundles.get(tenant.id)! }),
        ).rejects.toMatchObject({
          diagnosticCode:
            kind === 'shared extension schema'
              ? 'RUNTIME_CAN_CREATE'
              : kind === 'sequence'
                ? 'PUBLIC_SEQUENCE_ACCESS'
                : 'PUBLIC_TABLE_ACCESS',
        });
      } finally {
        await admin.query(cleanup);
      }
      await expect(
        executor.verify({ tenantId: tenant.id, bundle: bundles.get(tenant.id)! }),
      ).resolves.toBeUndefined();
    },
  );

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
        tenantDB.execute(sql.raw(`UPDATE __drizzle_migrations SET hash = 'tampered'`)),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  it("refuses another tenant's credentials through connection identity verification (AC-04-4)", async () => {
    const [a, b] = TENANTS;
    await expect(executor.verify({ bundle: bundles.get(b.id)!, tenantId: a.id })).rejects.toThrow();
  });

  it('rejects a changed historical migration without changing data or the ledger', async () => {
    const tenant = TENANTS[0];
    const { schemaName } = tenantDbNames(tenant.id);
    const journal = `"${schemaName}".__drizzle_migrations`;
    const before = await admin.query(`SELECT * FROM ${journal} ORDER BY id`);
    await admin.query(`UPDATE ${journal} SET hash = 'unknown-draft' WHERE id = $1`, [
      before.rows[0].id,
    ]);
    try {
      await expect(
        executor.migrate({
          bundle: bundles.get(tenant.id)!,
          tenantId: tenant.id,
          name: 'A',
          slug: tenant.slug,
          operationId: 'bad-history',
        }),
      ).rejects.toThrow();
      const after = await admin.query(`SELECT * FROM ${journal} ORDER BY id`);
      expect(after.rows).toEqual(
        before.rows.map((row, i) => (i === 0 ? { ...row, hash: 'unknown-draft' } : row)),
      );
      const users = await admin.query(`SELECT email FROM "${schemaName}".users`);
      expect(users.rows).toEqual([{ email: tenant.slug }]);
    } finally {
      await admin.query(`UPDATE ${journal} SET hash = $1 WHERE id = $2`, [
        before.rows[0].hash,
        before.rows[0].id,
      ]);
    }
  });

  it('rejects altered schema, missing business tables and writable migration journals', async () => {
    const tenant = TENANTS[0];
    const names = tenantDbNames(tenant.id);
    const verify = () => executor.verify({ tenantId: tenant.id, bundle: bundles.get(tenant.id)! });
    await admin.query(`ALTER SCHEMA "${names.schemaName}" OWNER TO postgres`);
    try {
      await expect(verify()).rejects.toThrow('SCHEMA_NOT_OWNED');
    } finally {
      await admin.query(`ALTER SCHEMA "${names.schemaName}" OWNER TO "${names.ownerUsername}"`);
    }
    await admin.query(`ALTER TABLE "${names.schemaName}".users RENAME TO users_saved`);
    try {
      await expect(verify()).rejects.toThrow();
    } finally {
      await admin.query(`ALTER TABLE "${names.schemaName}".users_saved RENAME TO users`);
    }
    await admin.query(
      `GRANT UPDATE ON "${names.schemaName}".__drizzle_migrations TO "${names.runtimeUsername}"`,
    );
    try {
      await expect(verify()).rejects.toThrow('MIGRATION_JOURNAL_ACCESS_INVALID');
    } finally {
      await admin.query(
        `REVOKE UPDATE ON "${names.schemaName}".__drizzle_migrations FROM "${names.runtimeUsername}"`,
      );
    }
    await expect(verify()).resolves.toBeUndefined();
  });

  it('keeps readiness evidence per version and re-verifies after invalidation', async () => {
    const tenant = TENANTS[0];
    const { schemaName } = tenantDbNames(tenant.id);
    let now = Date.now();
    const clock = () => new Date(now);
    const fresh = testRuntime(() => platformDB, new TenantPoolManager({ maxPools: 2 }), clock);
    await admitScope(fresh, tenant.slug);
    await admin.query(`ALTER TABLE "${schemaName}".users RENAME TO users_saved`);
    try {
      now += TENANT_ADMISSION_TTL_MS + 1; // evidence is per version, never clock-based
      await expect(admitScope(fresh, tenant.slug)).resolves.toBeDefined();
      fresh.invalidate(tenant.id);
      await expect(admitScope(fresh, tenant.slug)).rejects.toMatchObject({
        code: 'TENANT_NOT_READY',
      });
    } finally {
      await admin.query(`ALTER TABLE "${schemaName}".users_saved RENAME TO users`);
    }
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
    expect(
      (
        await service.executeLifecycle(b.id, 'evt-resume-b', {
          invalidateCaches: async () => {},
          closeRealtime: async () => {},
          stopQueue: async () => {},
          drainTransactions: async () => {},
          resumeQueue: async () => {},
        })
      ).status,
    ).toBe('applied');
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
    expect(
      (
        await service.executeLifecycle(b.id, 'evt-resume-b-2', {
          invalidateCaches: async () => {},
          closeRealtime: async () => {},
          stopQueue: async () => {},
          drainTransactions: async () => {},
          resumeQueue: async () => {},
        })
      ).status,
    ).toBe('applied');
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

  it('reopens a tenant whose lh_ roles the cutover renamed once Ops retargets its bundle', async () => {
    // Tenant B: active again after the previous case.
    const tenant = TENANTS[1];
    const names = tenantDbNames(tenant.id);
    const legacy = (role: string) => role.replace(/^titu_/, 'lh_');
    // The state the previous build left: lh_ roles and directory names.
    for (const role of [names.ownerUsername, names.runtimeUsername])
      await admin.query(`ALTER ROLE "${role}" RENAME TO "${legacy(role)}"`);
    await admin.query(
      `UPDATE public.tenant_directory SET owner_username = $2, runtime_username = $3 WHERE tenant_id = $1`,
      [tenant.id, legacy(names.ownerUsername), legacy(names.runtimeUsername)],
    );
    // The cutover window: rename the roles (password, grants and ownership stay)...
    for (const role of [names.ownerUsername, names.runtimeUsername])
      await admin.query(`ALTER ROLE "${legacy(role)}" RENAME TO "${role}"`);
    runtime.invalidate(tenant.id);
    await expect(admitScope(runtime, tenant.slug)).rejects.toMatchObject({
      code: 'TENANT_NOT_READY',
    });
    // ...then Ops retargets: same passwords, contract names, both versions up.
    const current = bundles.get(tenant.id)!;
    const directory = await admin.query<{ c: number; v: number }>(
      'SELECT connection_version AS c, credential_bundle_version AS v FROM public.tenant_directory WHERE tenant_id = $1',
      [tenant.id],
    );
    const retarget: DatasourceBundle = {
      ...current,
      connectionVersion: directory.rows[0].c + 1,
      credentialBundleVersion: directory.rows[0].v + 1,
    };
    expect(
      await service.receiveDatasource({
        datasource: retarget,
        operationId: `retarget-${tenant.slug}`,
        tenantId: tenant.id,
      }),
    ).toMatchObject({ errorCode: null, status: 'applied' });
    const after = await admin.query(
      'SELECT owner_username, runtime_username FROM public.tenant_directory WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(after.rows).toEqual([
      { owner_username: names.ownerUsername, runtime_username: names.runtimeUsername },
    ]);
    runtime.invalidate(tenant.id);
    const scope = await admitScope(runtime, tenant.slug);
    const rows = await runWithTenantScope(scope, () =>
      tenantDB.execute<{ user: string }>(sql`SELECT current_user AS user`),
    );
    expect(rows.rows).toEqual([{ user: names.runtimeUsername }]);
  }, 60_000);
});
