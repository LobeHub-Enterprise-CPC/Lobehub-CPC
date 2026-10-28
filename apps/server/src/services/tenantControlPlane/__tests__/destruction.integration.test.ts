// @vitest-environment node
/**
 * Per-tenant destruction on a real PostgreSQL (contracts/tenant-control-plane/tenant-destruction.json;
 * spec 34 section 4.99 items 7-12, acceptance 9.2-15 (e)(f)). Runs only when DATABASE_TEST_URL points at
 * a server where the connecting role may create databases; otherwise skipped. Every test uses its own
 * tenant UUIDs inside one throw-away database.
 */
import path from 'node:path';

import * as platformSchema from '@lobechat/database/platform';
import { TenantPoolManager } from '@lobechat/database/tenant';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { withDestructionFence } from '@/server/modules/Tenant/destruction';
import { TenantDirectoryRepository } from '@/server/modules/Tenant/directoryRepository';
import { TenantGateError } from '@/server/modules/Tenant/errors';
import { tenantClaims, tenantProcessLease } from '@/server/modules/Tenant/postgresClaims';
import { TenantRuntime } from '@/server/modules/Tenant/runtime';

import { ControlPlaneError, type DestructionRequest } from '../contracts';
import { tenantDbNames } from '../datasource';
import { TenantEndpointsService } from '../endpoints';
import { PostgresControlPlaneRepository } from '../postgresRepository';
import { TenantControlPlaneService } from '../service';
import { bundle, database, hooks, lifecycle, provision, rotate } from './service.testUtils';

// The runtime heartbeat reads the platform database through getPlatformDB: point it at the test database.
const platform = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@lobechat/database/platform', async (original) => ({
  ...(await original<object>()),
  getPlatformDB: () => platform.db,
}));

const ADMIN_URL = process.env.DATABASE_TEST_URL;
const suite = ADMIN_URL ? describe : describe.skip;
const DB_NAME = `lobehub_destruction_${process.pid}_${Date.now()}`;

const OP = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_OP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
// One tenant UUID per test keeps the cases independent inside one database.
let counter = 0;
const newTenant = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

const phase = (tenantId: string, name: DestructionRequest['phase'], operationId = OP) => ({
  destroyOperationId: operationId,
  phase: name,
  tenantId,
});

suite('tenant destruction on PostgreSQL', () => {
  let pool: Pool;
  let platformDB: ReturnType<typeof drizzle<typeof platformSchema>>;
  let repository: PostgresControlPlaneRepository;
  let executor: ReturnType<typeof database>;
  let service: TenantControlPlaneService;
  let endpoints: TenantEndpointsService;
  let retirePool: ReturnType<typeof vi.fn>;
  const previousSecret = process.env.KEY_VAULTS_SECRET;

  beforeAll(async () => {
    process.env.KEY_VAULTS_SECRET = 'destruction-integration-secret';
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE "${DB_NAME}" TEMPLATE template0`);
    await root.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;
    pool = new Pool({ connectionString: url.href, max: 12 });
    platformDB = drizzle(pool, { schema: platformSchema });
    platform.db = platformDB;
    const migrationsFolder = path.join(process.cwd(), 'packages/database/migrations/platform');
    // Twice: a rerun of the platform chain changes nothing.
    await migrate(platformDB, { migrationsFolder });
    await migrate(platformDB, { migrationsFolder });
    repository = new PostgresControlPlaneRepository(platformDB);
    executor = database();
    retirePool = vi.fn(() => true);
    service = new TenantControlPlaneService({
      database: executor,
      destruction: { drainBudgetMs: 600, drainPollMs: 50, retirePool },
      isRegistrableSlug: () => true,
      repository,
    });
    endpoints = new TenantEndpointsService(platformDB, 'https://app.test');
  }, 60_000);

  afterAll(async () => {
    process.env.KEY_VAULTS_SECRET = previousSecret;
    await pool?.end();
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await root.end();
  }, 60_000);

  const count = async (table: string, tenantId: string) =>
    Number(
      (await pool.query(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]))
        .rows[0].n,
    );
  const PLATFORM_TABLES = [
    'tenant_directory',
    'tenant_lifecycle',
    'tenant_lifecycle_inbox',
    'tenant_provision_operation',
    'tenant_runtime_external_work',
    'tenant_endpoints',
    'tenant_endpoint_state',
    'tenant_endpoint_events',
  ];
  const footprint = async (tenantId: string) =>
    Object.fromEntries(
      await Promise.all(PLATFORM_TABLES.map(async (t) => [t, await count(t, tenantId)] as const)),
    );

  /** A provisioned, activated tenant with an endpoint snapshot and a running external job. */
  const seed = async (slug: string, tenantId = newTenant()) => {
    const request = provision({
      datasource: bundle(tenantId),
      operationId: `op-${tenantId}`,
      slug,
      tenantId,
    });
    await service.receiveProvision(request);
    expect((await service.executeProvision(tenantId, request.operationId)).status).toBe('applied');
    await service.receiveLifecycle(
      lifecycle({
        desiredState: 'active',
        eventId: `evt-${tenantId}`,
        freezeReasons: [],
        tenantId,
      }),
    );
    await endpoints.receive({
      endpoints: [{ active: true, host: null, id: 'default', kind: 'default' }],
      eventId: `ep-${tenantId}`,
      tenantId,
      version: 1,
    });
    await pool.query(
      `INSERT INTO tenant_runtime_external_work(work_id, tenant_id, kind) VALUES ($1, $2, 'video')`,
      [`video:${tenantId}`, tenantId],
    );
    return { request, tenantId };
  };

  const refused = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(code);
  };

  it('creates the terminal table with checks, no slug and no foreign key', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_destruction' ORDER BY 1`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'completed_at',
      'destroy_operation_id',
      'drain_result',
      'tenant_id',
      'terminal_established_at',
    ]);
    const fks = await pool.query(
      `SELECT 1 FROM information_schema.table_constraints WHERE table_name = 'tenant_destruction' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(fks.rowCount).toBe(0);
    const id = newTenant();
    await expect(
      pool.query(`INSERT INTO tenant_destruction VALUES (now(), 'op', 'bogus', $1, now())`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`INSERT INTO tenant_destruction VALUES (now(), 'op', NULL, $1, now())`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('runs barrier, drain and unregister, leaves only the terminal, and is idempotent', async () => {
    const { tenantId } = await seed('acme');
    const other = await seed('bravo');
    const otherBefore = await footprint(other.tenantId);
    expect(Object.values(await footprint(tenantId)).every((n) => n > 0)).toBe(true);

    const barrier = await service.destruction.apply(phase(tenantId, 'barrier'));
    expect(barrier).toMatchObject({ completedAt: null, drainResult: null, status: 'applied' });
    // Nothing is deleted by the barrier.
    expect(Object.values(await footprint(tenantId)).every((n) => n > 0)).toBe(true);

    const drain = await service.destruction.apply(phase(tenantId, 'drain'));
    // The seeded external job was incomplete: it cannot write any more, so the drain says fenced.
    expect(drain).toMatchObject({ drainResult: 'fenced', status: 'applied' });

    const done = await service.destruction.apply(phase(tenantId, 'unregister'));
    expect(done.status).toBe('applied');
    expect(done.completedAt).not.toBeNull();
    expect(done.items).toEqual([
      { item: 'tenant_directory', result: 'deleted' },
      { item: 'active_connection', result: 'deleted' },
      { item: 'credential_bundle', result: 'deleted' },
      { item: 'control_plane_operations', result: 'deleted' },
      { item: 'endpoint_records', result: 'deleted' },
      { item: 'connection_pool', result: 'deleted' },
    ]);
    expect(Object.values(await footprint(tenantId)).every((n) => n === 0)).toBe(true);
    // The terminal remains, carrying no slug, name or credential.
    const terminal = await pool.query(`SELECT * FROM tenant_destruction WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(terminal.rows).toHaveLength(1);
    expect(Object.keys(terminal.rows[0]).sort()).toEqual([
      'completed_at',
      'destroy_operation_id',
      'drain_result',
      'tenant_id',
      'terminal_established_at',
    ]);
    expect(JSON.stringify(terminal.rows[0])).not.toContain('acme');

    // Response lost: every phase repeats, the unregister replays as absent, nothing is redone.
    retirePool.mockClear();
    expect(await service.destruction.apply(phase(tenantId, 'barrier'))).toEqual(barrier);
    expect(await service.destruction.apply(phase(tenantId, 'drain'))).toEqual(drain);
    const replay = await service.destruction.apply(phase(tenantId, 'unregister'));
    expect(replay).toMatchObject({ completedAt: done.completedAt, status: 'absent' });
    expect(replay.items).toBeUndefined();
    expect(retirePool).not.toHaveBeenCalled();
    expect(await service.destruction.status(tenantId, OP)).toMatchObject({
      completedAt: done.completedAt,
      reached: 'unregister',
    });

    // Another destroyOperationId is a conflict, in any phase, even after completion.
    for (const name of ['barrier', 'drain', 'unregister'] as const)
      await refused(
        service.destruction.apply(phase(tenantId, name, OTHER_OP)),
        'OPERATION_CONFLICT',
      );

    // The other tenant is untouched, and still answers.
    expect(await footprint(other.tenantId)).toEqual(otherBefore);
    expect(await service.getOverview(other.tenantId)).toMatchObject({ readiness: 'ready' });
  });

  it('refuses every delayed old request after unregister with TENANT_DESTROYED and revives nothing', async () => {
    const { request, tenantId } = await seed('delayed');
    for (const name of ['barrier', 'drain', 'unregister'] as const)
      await service.destruction.apply(phase(tenantId, name));
    const empty = await footprint(tenantId);
    expect(Object.values(empty).every((n) => n === 0)).toBe(true);

    // The very same provision operation, and a new one: neither falls into "first provision".
    await refused(service.receiveProvision(request), 'TENANT_DESTROYED');
    await refused(
      service.receiveProvision({ ...request, operationId: 'late-op' }),
      'TENANT_DESTROYED',
    );
    await refused(service.getProvision(tenantId, request.operationId), 'TENANT_DESTROYED');
    await refused(service.executeProvision(tenantId, request.operationId), 'TENANT_DESTROYED');
    await refused(
      service.receiveDatasource({
        ...rotate(),
        tenantId,
        datasource: bundle(tenantId, { credentialBundleVersion: 2 }),
      }),
      'TENANT_DESTROYED',
    );
    await refused(
      service.receiveLifecycle(lifecycle({ eventId: 'late-evt', tenantId, version: 5 })),
      'TENANT_DESTROYED',
    );
    await refused(service.getLifecycle(tenantId, 'late-evt'), 'TENANT_DESTROYED');
    await refused(service.executeLifecycle(tenantId, 'late-evt', hooks()), 'TENANT_DESTROYED');
    await refused(service.getOverview(tenantId), 'TENANT_DESTROYED');
    const names = tenantDbNames(tenantId);
    await refused(
      service.getDatasourceReadiness({
        datasource: {
          ...bundle(tenantId),
          runtimeCredential: { username: names.runtimeUsername },
          schemaOwner: { role: names.ownerUsername, username: names.ownerUsername },
        },
        tenantId,
      }),
      'TENANT_DESTROYED',
    );
    await refused(
      endpoints.receive({
        endpoints: [{ active: true, host: null, id: 'default', kind: 'default' }],
        eventId: 'late-ep',
        tenantId,
        version: 9,
      }),
      'TENANT_DESTROYED',
    );
    await refused(endpoints.get(tenantId, { control: true }), 'TENANT_DESTROYED');
    expect(await footprint(tenantId)).toEqual(empty);
    // The destroyed UUID did not leave a slug behind: the same slug is free.
    expect(
      (await pool.query(`SELECT 1 FROM tenant_directory WHERE slug = 'delayed'`)).rowCount,
    ).toBe(0);
  });

  it('lets the same slug be created again under a new UUID', async () => {
    const { tenantId } = await seed('reborn');
    for (const name of ['barrier', 'drain', 'unregister'] as const)
      await service.destruction.apply(phase(tenantId, name));
    const second = await seed('reborn');
    expect(second.tenantId).not.toBe(tenantId);
    expect(await service.getOverview(second.tenantId)).toMatchObject({
      readiness: 'ready',
      slug: 'reborn',
    });
    await refused(service.getOverview(tenantId), 'TENANT_DESTROYED');
  });

  it('establishes a terminal for a UUID the application never heard of, then refuses its provision', async () => {
    const tenantId = newTenant();
    await service.destruction.apply(phase(tenantId, 'barrier'));
    await refused(
      service.receiveProvision(
        provision({ datasource: bundle(tenantId), operationId: 'first', slug: 'ghost', tenantId }),
      ),
      'TENANT_DESTROYED',
    );
    expect(await footprint(tenantId)).toEqual(
      Object.fromEntries(PLATFORM_TABLES.map((t) => [t, 0])),
    );
    // Complete without any catalog: all items absent, completedAt still written.
    await service.destruction.apply(phase(tenantId, 'drain'));
    retirePool.mockReturnValueOnce(false);
    const done = await service.destruction.apply(phase(tenantId, 'unregister'));
    expect(done.items!.every((i) => i.result === 'absent')).toBe(true);
    expect(done.completedAt).not.toBeNull();
  });

  it('answers drain and unregister without their predecessor with DESTROY_PHASE_ORDER', async () => {
    const tenantId = newTenant();
    await refused(service.destruction.apply(phase(tenantId, 'drain')), 'DESTROY_PHASE_ORDER');
    await refused(service.destruction.apply(phase(tenantId, 'unregister')), 'DESTROY_PHASE_ORDER');
    expect(await count('tenant_destruction', tenantId)).toBe(0);
    await service.destruction.apply(phase(tenantId, 'barrier'));
    await refused(service.destruction.apply(phase(tenantId, 'unregister')), 'DESTROY_PHASE_ORDER');
    expect(await service.destruction.status(newTenant())).toMatchObject({ reached: null });
  });

  it('serialises concurrent barriers: one terminal, the other operation id conflicts', async () => {
    const tenantId = newTenant();
    const results = await Promise.allSettled([
      service.destruction.apply(phase(tenantId, 'barrier')),
      service.destruction.apply(phase(tenantId, 'barrier')),
      service.destruction.apply(phase(tenantId, 'barrier', OTHER_OP)),
      service.destruction.apply(phase(tenantId, 'barrier', OTHER_OP)),
    ]);
    const stored = (
      await pool.query(`SELECT destroy_operation_id FROM tenant_destruction WHERE tenant_id = $1`, [
        tenantId,
      ])
    ).rows;
    expect(stored).toHaveLength(1);
    const winner = stored[0].destroy_operation_id as string;
    for (const [index, result] of results.entries()) {
      const id = index < 2 ? OP : OTHER_OP;
      if (id === winner) expect(result.status).toBe('fulfilled');
      else {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ControlPlaneError);
        expect((result as PromiseRejectedResult).reason.code).toBe('OPERATION_CONFLICT');
      }
    }
  });

  it('waits for a control-plane transaction that passed its check before the barrier, then fences the next', async () => {
    const { tenantId } = await seed('inflight');
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    // A write that already passed its entry check and is still inside its transaction.
    const inFlight = repository.transaction(tenantId, async (tx) => {
      entered.resolve();
      await held.promise;
      const lifecycleRow = await tx.getLifecycle(tenantId);
      await tx.putLifecycle({ ...lifecycleRow!, acceptedVersion: 7, appliedVersion: 7 });
    });
    await entered.promise;
    let barrierDone = false;
    const barrier = service.destruction.apply(phase(tenantId, 'barrier')).then((r) => {
      barrierDone = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(barrierDone).toBe(false);
    held.resolve();
    await inFlight;
    await barrier;
    expect(barrierDone).toBe(true);
    // The next one, even though it began its life before, meets the terminal in its transaction.
    await refused(
      repository.transaction(tenantId, async (tx) => tx.getLifecycle(tenantId)),
      'TENANT_DESTROYED',
    );
  });

  it('does not let a delayed provision execution write after unregister', async () => {
    const tenantId = newTenant();
    const request = provision({
      datasource: bundle(tenantId),
      operationId: `slow-${tenantId}`,
      slug: 'slowpoke',
      tenantId,
    });
    await service.receiveProvision(request);
    const migration = Promise.withResolvers<void>();
    executor.migrate.mockImplementationOnce(() => migration.promise);
    const running = service.executeProvision(tenantId, request.operationId);
    await vi.waitFor(() => expect(executor.migrate).toHaveBeenCalled());

    await service.destruction.apply(phase(tenantId, 'barrier'));
    expect(await service.destruction.apply(phase(tenantId, 'drain'))).toMatchObject({
      drainResult: 'fenced',
    });
    await service.destruction.apply(phase(tenantId, 'unregister'));
    expect(Object.values(await footprint(tenantId)).every((n) => n === 0)).toBe(true);

    // The old execution wakes up after the catalog is gone: it must not write the directory back.
    migration.resolve();
    await refused(running, 'TENANT_DESTROYED');
    expect(Object.values(await footprint(tenantId)).every((n) => n === 0)).toBe(true);
  });

  it('keeps writers outside the control lock behind the destruction fence', async () => {
    const tenantId = newTenant();
    const write = Promise.withResolvers<void>();
    const inside = Promise.withResolvers<void>();
    // An external-work receipt past its check, still inside its transaction.
    const receipt = withDestructionFence(
      platformDB,
      tenantId,
      () => new TenantGateError('TENANT_DESTROYED'),
      async (tx) => {
        inside.resolve();
        await write.promise;
        await tx.execute(
          sql`INSERT INTO tenant_runtime_external_work(work_id, tenant_id, kind) VALUES (${`video:${tenantId}`}, ${tenantId}, 'video')`,
        );
      },
    );
    await inside.promise;
    let barrierDone = false;
    const barrier = service.destruction.apply(phase(tenantId, 'barrier')).then((r) => {
      barrierDone = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(barrierDone).toBe(false);
    write.resolve();
    await receipt;
    await barrier;
    // The row it wrote is a record of the old tenant; unregister removes it.
    expect(await count('tenant_runtime_external_work', tenantId)).toBe(1);
    // After the barrier no further external-work write is admitted, and no endpoint revision either.
    await refused(
      withDestructionFence(
        platformDB,
        tenantId,
        () => new TenantGateError('TENANT_DESTROYED'),
        async () => undefined,
      ),
      'TENANT_DESTROYED',
    );
    await refused(
      endpoints.receive({
        endpoints: [{ active: true, host: null, id: 'default', kind: 'default' }],
        eventId: 'after-barrier',
        tenantId,
        version: 1,
      }),
      'TENANT_DESTROYED',
    );
    await service.destruction.apply(phase(tenantId, 'drain'));
    await service.destruction.apply(phase(tenantId, 'unregister'));
    expect(await count('tenant_runtime_external_work', tenantId)).toBe(0);
  });

  it('keeps the drain open while a live runtime process has not let go of the tenant, ignoring expired ones', async () => {
    const tenantId = newTenant();
    await service.destruction.apply(phase(tenantId, 'barrier'));
    await pool.query(
      `INSERT INTO tenant_runtime_process(process_id, lease_expires_at, drained_generations) VALUES
        ('crashed-${tenantId}', now() - interval '1 minute', '{}'),
        ('live-${tenantId}', now() + interval '10 minutes', '{}')`,
    );
    const first = await service.destruction.apply(phase(tenantId, 'drain'));
    expect(first).toMatchObject({ drainResult: null, status: 'applying' });
    expect((await service.destruction.status(tenantId)).drainResult).toBeNull();
    await refused(service.destruction.apply(phase(tenantId, 'unregister')), 'DESTROY_PHASE_ORDER');

    // The live process drops the tenant and publishes the destroyed marker.
    await pool.query(
      `UPDATE tenant_runtime_process SET drained_generations = $2::jsonb WHERE process_id = $1`,
      [`live-${tenantId}`, JSON.stringify({ [tenantId]: -1 })],
    );
    expect(await service.destruction.apply(phase(tenantId, 'drain'))).toMatchObject({
      drainResult: 'drained',
      status: 'applied',
    });
    await pool.query(`DELETE FROM tenant_runtime_process WHERE process_id LIKE '%${tenantId}'`);
  });

  it('refuses admission to a destroyed tenant from the barrier on, before the directory row is gone', async () => {
    const { tenantId } = await seed('admission');
    const runtime = new TenantRuntime(() => platformDB, new TenantPoolManager({ maxPools: 1 }));
    await runtime.assertAdmitted(tenantId, 0);
    await service.destruction.apply(phase(tenantId, 'barrier'));
    await expect(runtime.assertAdmitted(tenantId, 0)).rejects.toMatchObject({
      code: 'TENANT_DESTROYED',
    });
    await expect(runtime.gatewayAdmission(tenantId)).rejects.toMatchObject({
      code: 'TENANT_DESTROYED',
    });
    const entry = await new TenantDirectoryRepository(() => platformDB).findById(tenantId);
    expect(entry?.destroyed).toBe(true);
    expect(await runtime.listAvailableTenantIds()).not.toContain(tenantId);
    // After unregister the tenant is simply not there.
    await service.destruction.apply(phase(tenantId, 'drain'));
    await service.destruction.apply(phase(tenantId, 'unregister'));
    await expect(runtime.assertAdmitted(tenantId, 0)).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });

  it('keeps the unregister of one tenant from touching another tenant that shares a custom host', async () => {
    const a = await seed('hosta');
    const b = await seed('hostb');
    await endpoints.receive({
      endpoints: [
        { active: false, host: null, id: 'default', kind: 'default' },
        { active: true, host: 'a.example.test', id: 'custom-a', kind: 'custom' },
      ],
      eventId: `ep2-${a.tenantId}`,
      tenantId: a.tenantId,
      version: 2,
    });
    const before = await footprint(b.tenantId);
    for (const name of ['barrier', 'drain', 'unregister'] as const)
      await service.destruction.apply(phase(a.tenantId, name));
    expect(await footprint(b.tenantId)).toEqual(before);
    // Its host is free again for a new tenant.
    const c = await seed('hostc');
    await endpoints.receive({
      endpoints: [
        { active: false, host: null, id: 'default', kind: 'default' },
        { active: true, host: 'a.example.test', id: 'custom-c', kind: 'custom' },
      ],
      eventId: `ep2-${c.tenantId}`,
      tenantId: c.tenantId,
      version: 2,
    });
  });

  it('completes the drain through a real heartbeat once the request pinned before the barrier is released', async () => {
    const { tenantId } = await seed('heartbeat');
    await pool.query(`DELETE FROM tenant_runtime_external_work WHERE tenant_id = $1`, [tenantId]);
    // A request admitted before the barrier is still running in this process.
    const release = await tenantClaims.enter(tenantId);
    await service.destruction.apply(phase(tenantId, 'barrier'));
    await tenantProcessLease.heartbeat();
    expect(await service.destruction.apply(phase(tenantId, 'drain'))).toMatchObject({
      drainResult: null,
      status: 'applying',
    });
    await release();
    await tenantProcessLease.heartbeat();
    const [{ drained_generations: acks }] = (
      await pool.query(
        `SELECT drained_generations FROM tenant_runtime_process WHERE process_id = $1`,
        [tenantProcessLease.processId],
      )
    ).rows;
    expect(acks[tenantId]).toBe(-1);
    expect(await service.destruction.apply(phase(tenantId, 'drain'))).toMatchObject({
      drainResult: 'drained',
      status: 'applied',
    });
    await tenantProcessLease.stop();
  });
});
