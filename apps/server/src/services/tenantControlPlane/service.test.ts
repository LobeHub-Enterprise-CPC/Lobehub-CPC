import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatasourceBundle, LifecycleRequest, ProvisionRequest } from './contracts';
import { tenantDbNames } from './datasource';
import { MemoryControlPlaneRepository } from './memoryRepository';
import {
  effectiveTenantState,
  type LifecycleHooks,
  TenantControlPlaneService,
  type TenantDatabaseExecutor,
} from './service';

const TENANT = '7a0c3d2e-1111-4222-8333-944455556666';
const NOW = new Date('2026-10-08T00:00:00.000Z');

const bundle = (tenantId = TENANT, over: Partial<DatasourceBundle> = {}): DatasourceBundle => {
  const names = tenantDbNames(tenantId);
  return {
    connectionVersion: 1,
    credentialBundleVersion: 1,
    database: 'lobehub',
    datasourceKind: 'lobehub',
    deploymentRef: 'default',
    host: 'pg-1.db.internal',
    mode: 'shared_schema',
    port: 5432,
    runtimeCredential: { password: 'run-secret', username: names.runtimeUsername },
    schemaName: names.schemaName,
    schemaOwner: {
      password: 'owner-secret',
      role: names.ownerUsername,
      username: names.ownerUsername,
    },
    schemaVersion: 1,
    tenantId,
    tls: { enabled: true, rejectUnauthorized: true },
    ...over,
  };
};

const provision = (over: Partial<ProvisionRequest> = {}): ProvisionRequest => ({
  datasource: bundle(over.tenantId ?? TENANT),
  name: 'Acme',
  operationId: 'root-1:lobehub',
  rootOperationId: 'root-1',
  slug: 'acme',
  tenantId: TENANT,
  ...over,
});

const lifecycle = (over: Partial<LifecycleRequest> = {}): LifecycleRequest => ({
  desiredState: 'frozen',
  eventId: 'evt-1',
  expiresAt: null,
  freezeReasons: ['manual'],
  occurredAt: NOW.toISOString(),
  tenantId: TENANT,
  version: 1,
  ...over,
});

const hooks = (): LifecycleHooks => ({
  closeRealtime: vi.fn(async () => {}),
  drainTransactions: vi.fn(async () => {}),
  invalidateCaches: vi.fn(async () => {}),
  resumeQueue: vi.fn(async () => {}),
  stopQueue: vi.fn(async () => {}),
});

const database = () =>
  ({
    checkOwnership: vi.fn(async () => {}),
    migrate: vi.fn(async () => {}),
    seed: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
    writeMarker: vi.fn(async () => {}),
  }) satisfies TenantDatabaseExecutor;

/** The checks Console runs on every lifecycle result (RESPONSE_MISMATCH otherwise). */
const assertConsoleInvariants = (
  r: Awaited<ReturnType<TenantControlPlaneService['receiveLifecycle']>>,
) => {
  expect(r.appliedVersion).toBeLessThanOrEqual(r.acceptedVersion);
  expect(r.acceptedVersion).toBeGreaterThanOrEqual(r.version);
  if (r.status === 'superseded') expect(r.acceptedVersion).toBeGreaterThan(r.version);
  if (r.status === 'applied') expect(r.appliedVersion).toBeGreaterThanOrEqual(r.version);
};

let repo: MemoryControlPlaneRepository;
let db: ReturnType<typeof database>;
let service: TenantControlPlaneService;

const makeService = (isRegistrableSlug = (slug: string) => slug !== 'admin') =>
  new TenantControlPlaneService({
    database: db,
    isRegistrableSlug,
    now: () => NOW,
    repository: repo,
  });

beforeEach(() => {
  repo = new MemoryControlPlaneRepository();
  db = database();
  service = makeService();
});

const provisionApplied = async (request = provision()) => {
  await service.receiveProvision(request);
  return service.executeProvision(request.tenantId, request.operationId);
};

describe('receiveProvision', () => {
  it('records a new operation as received and keeps its bundle for the executor', async () => {
    const result = await service.receiveProvision(provision());
    expect(result).toMatchObject({ datasourceReady: false, errorCode: null, status: 'received' });
    expect(repo.operations.get('root-1:lobehub')!.step).toBe('ownership');
    expect(repo.operationBundles.get('root-1:lobehub')).toEqual(bundle());
  });

  it('keeps passwords out of the operation record', async () => {
    await service.receiveProvision(provision());
    expect(JSON.stringify([...repo.operations.values()])).not.toContain('secret');
  });

  it('returns the same result for an identical retry without new side effects', async () => {
    await service.receiveProvision(provision());
    await service.receiveProvision(provision());
    expect(repo.operations.size).toBe(1);
  });

  it('treats a retry that only changes passwords as the same request', async () => {
    await service.receiveProvision(provision());
    const changed = bundle(TENANT, {
      runtimeCredential: { ...bundle().runtimeCredential, password: 'rotated' },
    });
    const result = await service.receiveProvision(provision({ datasource: changed }));
    expect(result.status).toBe('received');
  });

  it('refuses the same operation id with different input', async () => {
    await service.receiveProvision(provision());
    await expect(service.receiveProvision(provision({ name: 'Other' }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
    });
    await expect(
      service.receiveProvision(provision({ datasource: bundle(TENANT, { port: 6543 }) })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
  });

  it('fails a reserved slug without creating anything to provision', async () => {
    const result = await service.receiveProvision(provision({ slug: 'admin' }));
    expect(result).toMatchObject({ errorCode: 'TENANT_INVALID', status: 'failed' });
    expect(repo.operationBundles.size).toBe(0);
  });

  it.each<[string, Partial<DatasourceBundle>]>([
    ['a schema not derived from the tenant id', { schemaName: 'tenant_acme' }],
    ['an unsupported schema version', { schemaVersion: 99 }],
    ['an Admin bundle', { datasourceKind: 'admin' }],
  ])('fails %s with DATASOURCE_INVALID before any DB work', async (_, over) => {
    const result = await service.receiveProvision(provision({ datasource: bundle(TENANT, over) }));
    expect(result).toMatchObject({ errorCode: 'DATASOURCE_INVALID', status: 'failed' });
    expect(repo.operationBundles.size).toBe(0);
    await service.executeProvision(TENANT, 'root-1:lobehub');
    expect(db.checkOwnership).not.toHaveBeenCalled();
    expect(db.migrate).not.toHaveBeenCalled();
  });

  it('trusts whatever database host Console sends', async () => {
    const result = await service.receiveProvision(
      provision({ datasource: bundle(TENANT, { host: '10.20.30.40' }) }),
    );
    expect(result).toMatchObject({ errorCode: null, status: 'received' });
  });

  it('re-validates a failed validation on retry, so a fixed deployment lets it through', async () => {
    service = makeService(() => false);
    await service.receiveProvision(provision());
    service = makeService();
    const result = await service.receiveProvision(provision());
    expect(result).toMatchObject({ errorCode: null, status: 'received' });
    expect(repo.operationBundles.has('root-1:lobehub')).toBe(true);
  });

  it('requeues a failed operation when Console re-posts it, at the step that failed', async () => {
    db.migrate.mockRejectedValueOnce(new Error('postgres://lh:pw@host failed'));
    const failed = await provisionApplied();
    expect(failed).toMatchObject({ errorCode: 'TENANT_PROVISION_FAILED', status: 'failed' });

    const result = await service.receiveProvision(provision());
    expect(result).toMatchObject({ errorCode: null, status: 'received' });
    expect(repo.operations.get('root-1:lobehub')!.step).toBe('migrate');
  });

  it('refuses a second operation for an already provisioned tenant', async () => {
    await provisionApplied();
    await expect(
      service.receiveProvision(
        provision({ operationId: 'root-2:lobehub', rootOperationId: 'root-2' }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_INVALID', status: 409 });
  });

  it('refuses a slug another tenant already holds', async () => {
    await service.receiveProvision(provision());
    await expect(
      service.receiveProvision(
        provision({ operationId: 'other:lobehub', rootOperationId: 'other', tenantId: 'other' }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_INVALID', status: 409 });
  });

  it('keeps a freshly provisioned tenant closed until Console activates it', async () => {
    await provisionApplied();
    const overview = await service.getOverview(TENANT);
    expect(overview).toMatchObject({ effectiveState: 'offline', readiness: 'ready' });
  });
});

describe('executeProvision', () => {
  it('runs every step in order, registers the directory and reports applied', async () => {
    const order: string[] = [];
    for (const [name, fn] of Object.entries(db))
      fn.mockImplementation(async () => void order.push(name));

    const result = await provisionApplied();
    expect(order).toEqual(['checkOwnership', 'migrate', 'writeMarker', 'seed', 'verify']);
    expect(result).toEqual({
      credentialBundleVersion: 1,
      datasourceReady: true,
      errorCode: null,
      operationId: 'root-1:lobehub',
      schemaName: tenantDbNames(TENANT).schemaName,
      schemaVersion: 1,
      status: 'applied',
      tenantId: TENANT,
    });
    expect(repo.directory.get(TENANT)!.record).toMatchObject({
      credentialBundleVersion: 1,
      status: 'active',
    });
    // The directory holds the bundle now; the operation's copy is gone.
    expect(repo.operationBundles.size).toBe(0);
  });

  it.each<[keyof TenantDatabaseExecutor, string]>([
    ['checkOwnership', 'DATASOURCE_INVALID'],
    ['migrate', 'TENANT_PROVISION_FAILED'],
    ['writeMarker', 'TENANT_PROVISION_FAILED'],
    ['seed', 'TENANT_PROVISION_FAILED'],
    ['verify', 'DATASOURCE_INVALID'],
  ])('fails with the code of the step that failed (%s → %s)', async (step, code) => {
    db[step].mockRejectedValueOnce(new Error('boom'));
    const result = await provisionApplied();
    expect(result).toMatchObject({ datasourceReady: false, errorCode: code, status: 'failed' });
  });

  it('does not migrate when the ownership check fails', async () => {
    db.checkOwnership.mockRejectedValueOnce(new Error('schema owned by someone else'));
    await provisionApplied();
    expect(db.migrate).not.toHaveBeenCalled();
  });

  it('resumes at the failed step instead of redoing finished ones', async () => {
    db.seed.mockRejectedValueOnce(new Error('boom'));
    await provisionApplied();
    await service.receiveProvision(provision());
    const result = await service.executeProvision(TENANT, 'root-1:lobehub');
    expect(result.status).toBe('applied');
    expect(db.migrate).toHaveBeenCalledTimes(1);
    expect(db.seed).toHaveBeenCalledTimes(2);
  });

  it('never puts the database error into the result', async () => {
    db.migrate.mockRejectedValueOnce(new Error('postgres://lh:owner-secret@host'));
    expect(JSON.stringify(await provisionApplied())).not.toContain('secret');
  });
});

const rotate = (over: Partial<DatasourceBundle> = {}) => ({
  datasource: bundle(TENANT, {
    credentialBundleVersion: 2,
    runtimeCredential: {
      password: 'run-secret-2',
      username: tenantDbNames(TENANT).runtimeUsername,
    },
    ...over,
  }),
  operationId: 'rot-1',
  tenantId: TENANT,
});

describe('receiveDatasource', () => {
  it('is not found for a tenant without a directory record', async () => {
    await service.receiveProvision(provision());
    await expect(service.receiveDatasource(rotate())).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
      status: 404,
    });
  });

  it('verifies the new credentials, then swaps them into the directory', async () => {
    await provisionApplied();
    db.verify.mockClear();
    const result = await service.receiveDatasource(rotate({ connectionVersion: 2 }));
    expect(result).toEqual({
      connectionVersion: 2,
      credentialBundleVersion: 2,
      datasourceKind: 'lobehub',
      errorCode: null,
      operationId: 'rot-1',
      status: 'applied',
      tenantId: TENANT,
    });
    expect(db.verify).toHaveBeenCalledWith(
      expect.objectContaining({ bundle: rotate({ connectionVersion: 2 }).datasource }),
    );
    expect(repo.directory.get(TENANT)).toMatchObject({
      bundle: { runtimeCredential: { password: 'run-secret-2' } },
      record: { connectionVersion: 2, credentialBundleVersion: 2 },
    });
  });

  it('keeps the old credentials when verification fails', async () => {
    await provisionApplied();
    db.verify.mockRejectedValueOnce(new Error('password authentication failed'));
    const result = await service.receiveDatasource(rotate());
    expect(result).toMatchObject({ errorCode: 'DATASOURCE_INVALID', status: 'failed' });
    expect(repo.directory.get(TENANT)!.record.credentialBundleVersion).toBe(1);
  });

  it('fails validation the same way provisioning does', async () => {
    await provisionApplied();
    const result = await service.receiveDatasource(rotate({ schemaVersion: 99 }));
    expect(result).toMatchObject({ errorCode: 'DATASOURCE_INVALID', status: 'failed' });
  });

  it('is idempotent for the same version and content', async () => {
    await provisionApplied();
    await service.receiveDatasource(rotate());
    db.verify.mockClear();
    expect((await service.receiveDatasource(rotate())).status).toBe('applied');
    expect(db.verify).not.toHaveBeenCalled();
  });

  it('refuses the same version with different content, passwords included', async () => {
    await provisionApplied();
    await service.receiveDatasource(rotate());
    const other = rotate();
    other.datasource.schemaOwner.password = 'different';
    await expect(service.receiveDatasource(other)).rejects.toMatchObject({
      code: 'DATASOURCE_VERSION_CONFLICT',
      status: 409,
    });
  });

  it('refuses an older bundle version', async () => {
    await provisionApplied();
    await service.receiveDatasource(rotate({ credentialBundleVersion: 3 }));
    await expect(service.receiveDatasource(rotate())).rejects.toMatchObject({
      code: 'DATASOURCE_VERSION_CONFLICT',
      status: 409,
    });
  });

  it('refuses a connection version that goes backwards', async () => {
    await provisionApplied();
    await service.receiveDatasource(rotate({ connectionVersion: 3 }));
    await expect(
      service.receiveDatasource(rotate({ connectionVersion: 2, credentialBundleVersion: 3 })),
    ).rejects.toMatchObject({ code: 'DATASOURCE_VERSION_CONFLICT', status: 409 });
  });
});

describe('receiveLifecycle', () => {
  beforeEach(async () => {
    await provisionApplied();
  });

  it('is not found for a tenant LobeHub never saw', async () => {
    await expect(
      service.receiveLifecycle(lifecycle({ tenantId: 'stranger' })),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND', status: 404 });
  });

  it('accepts a new version and closes the gate in the same step', async () => {
    const result = await service.receiveLifecycle(lifecycle());
    expect(result).toMatchObject({ acceptedVersion: 1, appliedVersion: 0, status: 'received' });
    assertConsoleInvariants(result);
    expect(repo.lifecycles.get(TENANT)).toMatchObject({
      desiredState: 'frozen',
      freezeReasons: ['manual'],
    });
  });

  it('returns the stored record for an identical retry', async () => {
    const first = await service.receiveLifecycle(lifecycle());
    expect(await service.receiveLifecycle(lifecycle())).toEqual(first);
  });

  it('refuses a reused event id with different content', async () => {
    await service.receiveLifecycle(lifecycle());
    await expect(
      service.receiveLifecycle(lifecycle({ freezeReasons: ['security'] })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
  });

  it('refuses a version another event already holds', async () => {
    await service.receiveLifecycle(lifecycle());
    await expect(service.receiveLifecycle(lifecycle({ eventId: 'evt-x' }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });

  it('records an older version as superseded without touching state', async () => {
    await service.receiveLifecycle(lifecycle({ eventId: 'evt-2', version: 2 }));
    const late = await service.receiveLifecycle(
      lifecycle({ desiredState: 'active', eventId: 'evt-1', freezeReasons: [], version: 1 }),
    );
    expect(late.status).toBe('superseded');
    assertConsoleInvariants(late);
    expect(repo.lifecycles.get(TENANT)!.desiredState).toBe('frozen');
  });
});

describe('executeLifecycle', () => {
  beforeEach(async () => {
    await provisionApplied();
  });

  it('runs the closing phases in order and marks the event applied', async () => {
    await service.receiveLifecycle(lifecycle());
    const h = hooks();
    const order: string[] = [];
    for (const [name, fn] of Object.entries(h))
      (fn as ReturnType<typeof vi.fn>).mockImplementation(async () => void order.push(name));

    const result = await service.executeLifecycle(TENANT, 'evt-1', h);
    expect(order).toEqual(['invalidateCaches', 'closeRealtime', 'stopQueue', 'drainTransactions']);
    expect(result).toMatchObject({ appliedVersion: 1, status: 'applied' });
    assertConsoleInvariants(result);
  });

  it('resumes the queue when activating', async () => {
    await service.receiveLifecycle(lifecycle({ desiredState: 'active', freezeReasons: [] }));
    const h = hooks();
    await service.executeLifecycle(TENANT, 'evt-1', h);
    expect(h.resumeQueue).toHaveBeenCalled();
    expect(h.drainTransactions).not.toHaveBeenCalled();
  });

  it('stops a slow executor when a newer event arrives mid-drain', async () => {
    await service.receiveLifecycle(lifecycle());
    const h = hooks();
    (h.closeRealtime as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await service.receiveLifecycle(
        lifecycle({ desiredState: 'active', eventId: 'evt-2', freezeReasons: [], version: 2 }),
      );
    });

    const result = await service.executeLifecycle(TENANT, 'evt-1', h);
    expect(result.status).toBe('superseded');
    assertConsoleInvariants(result);
    expect(h.drainTransactions).not.toHaveBeenCalled();
    // The newer state stands; the old event never reached appliedVersion.
    expect(repo.lifecycles.get(TENANT)).toMatchObject({
      appliedVersion: 0,
      desiredState: 'active',
    });
  });

  it('fails on a drain timeout but keeps the gate closed, then retries', async () => {
    await service.receiveLifecycle(lifecycle());
    const h = hooks();
    (h.drainTransactions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('timeout'));

    const failed = await service.executeLifecycle(TENANT, 'evt-1', h);
    expect(failed).toMatchObject({ errorCode: 'LIFECYCLE_FAILED', status: 'failed' });
    expect(repo.lifecycles.get(TENANT)!.desiredState).toBe('frozen');

    expect((await service.receiveLifecycle(lifecycle())).status).toBe('received');
    expect((await service.executeLifecycle(TENANT, 'evt-1', h)).status).toBe('applied');
  });

  it('will not activate a tenant whose datasource is not ready', async () => {
    const other = 'tenant-b';
    await service.receiveProvision(
      provision({ operationId: 'b:lobehub', rootOperationId: 'b', slug: 'beta', tenantId: other }),
    );
    await service.receiveLifecycle(
      lifecycle({ desiredState: 'active', freezeReasons: [], tenantId: other }),
    );
    const result = await service.executeLifecycle(other, 'evt-1', hooks());
    expect(result).toMatchObject({ errorCode: 'TENANT_NOT_READY', status: 'failed' });
  });
});

describe('effectiveTenantState', () => {
  const base = { desiredState: 'active' as const, expiresAt: null, freezeReasons: [] };

  it('is active with no reasons and no expiry', () => {
    expect(effectiveTenantState(base, NOW)).toEqual({ reasons: [], state: 'active' });
  });

  it('freezes at expiry without waiting for an expired event', () => {
    expect(effectiveTenantState({ ...base, expiresAt: NOW.toISOString() }, NOW)).toEqual({
      reasons: ['expired'],
      state: 'frozen',
    });
  });

  it('puts offline above frozen', () => {
    expect(
      effectiveTenantState({ ...base, desiredState: 'offline', freezeReasons: ['manual'] }, NOW)
        .state,
    ).toBe('offline');
  });
});
