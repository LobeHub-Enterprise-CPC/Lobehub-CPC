import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { database } from './__tests__/service.testUtils';
import {
  bundle,
  hooks,
  lifecycle,
  NOW,
  provision,
  provisionApplied,
  resetService,
  rotate,
  TENANT,
} from './__tests__/service.testUtils';
import { ControlPlaneError, type DestructionRequest } from './contracts';
import type { MemoryControlPlaneRepository } from './memoryRepository';
import { TenantControlPlaneService } from './service';

const OP = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_OP = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const OTHER_TENANT = '8a6d2f40-1c3b-4e7a-b5d9-6f0e2a4c8b13';

const request = (phase: DestructionRequest['phase'], over: Partial<DestructionRequest> = {}) => ({
  destroyOperationId: OP,
  phase,
  tenantId: TENANT,
  ...over,
});

let repo: MemoryControlPlaneRepository;
let service: TenantControlPlaneService;
let db: ReturnType<typeof database>;
let retirePool: ReturnType<typeof vi.fn>;
let clockNow = 0;

/** A service whose drain waits on a fake clock instead of real time. */
const destructionService = () => {
  retirePool = vi.fn(() => true);
  return new TenantControlPlaneService({
    database: db,
    destruction: {
      clock: () => clockNow,
      drainBudgetMs: 1000,
      drainPollMs: 250,
      retirePool,
      sleep: async (ms) => {
        clockNow += ms;
      },
    },
    isRegistrableSlug: (slug) => slug !== 'admin',
    now: () => NOW,
    repository: repo,
  });
};

const refused = async (promise: Promise<unknown>, code: string, status: number) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ControlPlaneError);
  expect(error).toMatchObject({ code, status });
};

beforeEach(() => {
  ({ repo, db } = resetService());
  clockNow = 0;
  service = destructionService();
});

describe('barrier', () => {
  it('creates the terminal even for a tenant this application never heard of', async () => {
    expect(await service.destruction.apply(request('barrier'))).toEqual({
      completedAt: null,
      destroyOperationId: OP,
      drainResult: null,
      phase: 'barrier',
      status: 'applied',
      tenantId: TENANT,
      terminalEstablishedAt: NOW.toISOString(),
    });
    expect(repo.destructions.get(TENANT)).toMatchObject({ destroyOperationId: OP });
  });

  it('answers a repeat with the original timestamp, and another operation id with a conflict', async () => {
    await service.destruction.apply(request('barrier'));
    const later = new TenantControlPlaneService({
      database: db,
      isRegistrableSlug: () => true,
      now: () => new Date(NOW.getTime() + 60_000),
      repository: repo,
    });
    expect((await later.destruction.apply(request('barrier'))).terminalEstablishedAt).toBe(
      NOW.toISOString(),
    );
    await refused(
      later.destruction.apply(request('barrier', { destroyOperationId: OTHER_OP })),
      'OPERATION_CONFLICT',
      409,
    );
  });

  it('keeps the terminal free of anything but the contract fields', async () => {
    await provisionApplied();
    await service.destruction.apply(request('barrier'));
    expect(Object.keys(repo.destructions.get(TENANT)!).sort()).toEqual([
      'completedAt',
      'destroyOperationId',
      'drainResult',
      'tenantId',
      'terminalEstablishedAt',
    ]);
  });
});

describe('phase order', () => {
  it('refuses drain and unregister without a barrier, and unregister without a drain', async () => {
    await refused(service.destruction.apply(request('drain')), 'DESTROY_PHASE_ORDER', 409);
    await refused(service.destruction.apply(request('unregister')), 'DESTROY_PHASE_ORDER', 409);
    await service.destruction.apply(request('barrier'));
    await refused(service.destruction.apply(request('unregister')), 'DESTROY_PHASE_ORDER', 409);
  });

  it('refuses every phase of another destroyOperationId once a terminal exists', async () => {
    await service.destruction.apply(request('barrier'));
    for (const phase of ['barrier', 'drain', 'unregister'] as const)
      await refused(
        service.destruction.apply(request(phase, { destroyOperationId: OTHER_OP })),
        'OPERATION_CONFLICT',
        409,
      );
  });
});

describe('drain', () => {
  beforeEach(async () => {
    await service.destruction.apply(request('barrier'));
  });

  it('reports drained when nothing was running', async () => {
    expect(await service.destruction.apply(request('drain'))).toMatchObject({
      completedAt: null,
      drainResult: 'drained',
      phase: 'drain',
      status: 'applied',
    });
  });

  it('answers a repeat with the original drain result', async () => {
    await service.destruction.apply(request('drain'));
    repo.drainBlockers.set(TENANT, { externalWork: true, processes: false });
    expect(await service.destruction.apply(request('drain'))).toMatchObject({
      drainResult: 'drained',
      status: 'applied',
    });
  });

  it('answers 202 applying while a runtime process still holds the tenant, then continues', async () => {
    repo.drainBlockers.set(TENANT, { externalWork: false, processes: true });
    expect(await service.destruction.apply(request('drain'))).toEqual({
      completedAt: null,
      destroyOperationId: OP,
      drainResult: null,
      phase: 'drain',
      status: 'applying',
      tenantId: TENANT,
      terminalEstablishedAt: NOW.toISOString(),
    });
    expect(repo.destructions.get(TENANT)!.drainResult).toBeNull();
    // The same request, repeated, finishes once the process has let go.
    repo.drainBlockers.delete(TENANT);
    expect(await service.destruction.apply(request('drain'))).toMatchObject({
      drainResult: 'drained',
      status: 'applied',
    });
  });
});

describe('drain of work that was running when the barrier fell', () => {
  const OTHER = OTHER_TENANT;

  it('revokes the lease of an execution that is still running and reports fenced', async () => {
    // Claim the provision, but leave its (mocked) migration pending across the barrier.
    await service.receiveProvision(provision());
    const migration = Promise.withResolvers<void>();
    db.migrate.mockImplementation(() => migration.promise);
    const running = service.executeProvision(TENANT, 'root-1:lobehub');
    await vi.waitFor(() => expect(db.migrate).toHaveBeenCalled());
    expect([...repo.operations.values()][0]).toMatchObject({ status: 'applying' });

    await service.destruction.apply(request('barrier'));
    expect(await service.destruction.apply(request('drain'))).toMatchObject({
      drainResult: 'fenced',
      status: 'applied',
    });
    expect([...repo.operations.values()][0]).toMatchObject({ leaseToken: null, leaseUntil: null });

    // The execution resumes: its next write is refused and nothing is written back.
    migration.resolve();
    await refused(running, 'TENANT_DESTROYED', 409);
    expect(repo.directory.has(TENANT)).toBe(false);
    expect([...repo.operations.values()][0]).toMatchObject({ status: 'applying' });
  });

  it('leaves another tenant alone', async () => {
    await provisionApplied(provision({ operationId: 'other-1', slug: 'other', tenantId: OTHER }));
    await service.destruction.apply(request('barrier'));
    await service.destruction.apply(request('drain'));
    await service.destruction.apply(request('unregister'));
    expect(repo.directory.get(OTHER)).toBeDefined();
    expect(await service.getOverview(OTHER)).toMatchObject({ readiness: 'ready', slug: 'other' });
  });
});

describe('unregister', () => {
  const ITEMS = [
    'tenant_directory',
    'active_connection',
    'credential_bundle',
    'control_plane_operations',
    'endpoint_records',
    'connection_pool',
  ];

  beforeEach(async () => {
    await provisionApplied();
    await service.receiveLifecycle(lifecycle());
    repo.endpointRecords.add(TENANT);
    await service.destruction.apply(request('barrier'));
    await service.destruction.apply(request('drain'));
  });

  it('removes the catalog entries, reports them under the contract names, and writes completedAt', async () => {
    const result = await service.destruction.apply(request('unregister'));
    expect(result).toEqual({
      completedAt: NOW.toISOString(),
      destroyOperationId: OP,
      drainResult: 'drained',
      items: ITEMS.map((item) => ({ item, result: 'deleted' })),
      phase: 'unregister',
      status: 'applied',
      tenantId: TENANT,
      terminalEstablishedAt: NOW.toISOString(),
    });
    expect(retirePool).toHaveBeenCalledWith(TENANT);
    expect(repo.directory.has(TENANT)).toBe(false);
    expect(repo.lifecycles.has(TENANT)).toBe(false);
    expect(repo.operations.size).toBe(0);
    expect(repo.events.size).toBe(0);
    expect(repo.operationBundles.size).toBe(0);
    expect(repo.endpointRecords.has(TENANT)).toBe(false);
    // The terminal itself is never removed.
    expect(repo.destructions.get(TENANT)).toMatchObject({ completedAt: NOW.toISOString() });
  });

  it('replays a completed unregister as absent, with the original timestamps and no deletion', async () => {
    await service.destruction.apply(request('unregister'));
    retirePool.mockClear();
    const replay = await service.destruction.apply(request('unregister'));
    expect(replay).toEqual({
      completedAt: NOW.toISOString(),
      destroyOperationId: OP,
      drainResult: 'drained',
      phase: 'unregister',
      status: 'absent',
      tenantId: TENANT,
      terminalEstablishedAt: NOW.toISOString(),
    });
    expect(retirePool).not.toHaveBeenCalled();
    // An earlier phase repeats as applied, still showing only what it showed at the time.
    expect(await service.destruction.apply(request('barrier'))).toMatchObject({
      completedAt: null,
      drainResult: null,
      status: 'applied',
    });
    expect(await service.destruction.apply(request('drain'))).toMatchObject({
      completedAt: null,
      drainResult: 'drained',
      status: 'applied',
    });
  });

  it('continues after a crash with the terminal intact, never reporting completion early', async () => {
    const original = repo.transaction.bind(repo);
    let crashed = false;
    vi.spyOn(repo, 'transaction').mockImplementation(((id, fn, options) =>
      original(
        id,
        async (tx) => {
          const result = await fn(tx);
          if (
            options?.destruction &&
            !crashed &&
            result &&
            (result as any).phase === 'unregister'
          ) {
            crashed = true;
            throw new Error('connection lost before commit');
          }
          return result;
        },
        options,
      )) as typeof repo.transaction);

    await refused(
      service.destruction.apply(request('unregister')),
      'TENANT_DESTRUCTION_FAILED',
      503,
    );
    // Rolled back: nothing deleted, completedAt still null.
    expect(repo.directory.has(TENANT)).toBe(true);
    expect(await service.destruction.status(TENANT, OP)).toMatchObject({
      completedAt: null,
      reached: 'drain',
    });
    expect(await service.destruction.apply(request('unregister'))).toMatchObject({
      status: 'applied',
    });
    expect((await service.destruction.status(TENANT, OP)).reached).toBe('unregister');
  });

  it('is not complete merely because the directory row is already gone', async () => {
    repo.directory.delete(TENANT);
    expect(await service.destruction.status(TENANT, OP)).toMatchObject({
      completedAt: null,
      reached: 'drain',
    });
    const result = await service.destruction.apply(request('unregister'));
    expect(result.items?.find((i) => i.item === 'tenant_directory')).toEqual({
      item: 'tenant_directory',
      result: 'absent',
    });
    expect(result.items?.find((i) => i.item === 'control_plane_operations')?.result).toBe(
      'deleted',
    );
  });

  it('answers a tenant that never had a catalog with absent items and still completes', async () => {
    const other = '5b7e9a21-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
    const never = request('barrier', { tenantId: other });
    await service.destruction.apply(never);
    await service.destruction.apply({ ...never, phase: 'drain' });
    retirePool.mockReturnValue(false);
    const result = await service.destruction.apply({ ...never, phase: 'unregister' });
    expect(result.status).toBe('applied');
    expect(result.items!.map((i) => i.result)).toEqual(Array.from({ length: 6 }).fill('absent'));
    expect(result.completedAt).not.toBeNull();
  });
});

describe('status', () => {
  it('answers 200 with everything null for a UUID without a terminal, never not-found', async () => {
    expect(await service.destruction.status(TENANT)).toEqual({
      completedAt: null,
      destroyOperationId: null,
      drainResult: null,
      reached: null,
      tenantId: TENANT,
      terminalEstablishedAt: null,
    });
    expect(repo.destructions.size).toBe(0);
  });

  it('follows the highest complete phase and conflicts only when asked about another id', async () => {
    await service.destruction.apply(request('barrier'));
    expect(await service.destruction.status(TENANT, OP)).toMatchObject({ reached: 'barrier' });
    await service.destruction.apply(request('drain'));
    expect(await service.destruction.status(TENANT)).toMatchObject({
      destroyOperationId: OP,
      drainResult: 'drained',
      reached: 'drain',
    });
    await refused(service.destruction.status(TENANT, OTHER_OP), 'OPERATION_CONFLICT', 409);
    await service.destruction.apply(request('unregister'));
    expect(await service.destruction.status(TENANT, OP)).toMatchObject({
      completedAt: NOW.toISOString(),
      reached: 'unregister',
    });
  });
});

describe('TENANT_DESTROYED fencing of the other control-plane entries', () => {
  const destroyedFor = async (run: () => Promise<unknown>) =>
    refused(run(), 'TENANT_DESTROYED', 409);

  beforeEach(async () => {
    await provisionApplied();
    await service.receiveLifecycle(lifecycle());
    await service.destruction.apply(request('barrier'));
  });

  it('refuses every entry from the barrier on, whatever the operation id', async () => {
    await destroyedFor(() => service.receiveProvision(provision({ operationId: 'late-1' })));
    await destroyedFor(() => service.receiveProvision(provision()));
    await destroyedFor(() => service.getProvision(TENANT, 'root-1:lobehub'));
    await destroyedFor(() => service.receiveDatasource(rotate()));
    await destroyedFor(() =>
      service.getDatasourceReadiness({
        datasource: {
          ...bundle(),
          runtimeCredential: { username: bundle().runtimeCredential.username },
          schemaOwner: { role: bundle().schemaOwner.role, username: bundle().schemaOwner.username },
        },
        tenantId: TENANT,
      }),
    );
    await destroyedFor(() => service.receiveLifecycle(lifecycle({ eventId: 'e2', version: 2 })));
    await destroyedFor(() => service.getLifecycle(TENANT, 'evt-1'));
    await destroyedFor(() => service.getOverview(TENANT));
    await destroyedFor(() => service.executeProvision(TENANT, 'root-1:lobehub'));
    await destroyedFor(() => service.executeLifecycle(TENANT, 'evt-1', hooks()));
  });

  it('answers TENANT_DESTROYED, not a first provision, after the catalog is gone', async () => {
    await service.destruction.apply(request('drain'));
    await service.destruction.apply(request('unregister'));
    expect(repo.operations.size).toBe(0);
    await destroyedFor(() => service.receiveProvision(provision({ operationId: 'late-2' })));
    await destroyedFor(() => service.getOverview(TENANT));
    await destroyedFor(() => service.receiveDatasource(rotate()));
    await destroyedFor(() => service.receiveLifecycle(lifecycle({ eventId: 'e3', version: 3 })));
    // Nothing came back to life.
    expect(repo.directory.size).toBe(0);
    expect(repo.operations.size).toBe(0);
    expect(repo.lifecycles.size).toBe(0);
    expect(repo.events.size).toBe(0);
  });

  it('lets other tenants through, including a new UUID for the destroyed tenant slug', async () => {
    await service.destruction.apply(request('drain'));
    await service.destruction.apply(request('unregister'));
    const reborn = provision({
      datasource: bundle(OTHER_TENANT),
      operationId: 'reborn-1',
      tenantId: OTHER_TENANT,
    });
    expect((await service.receiveProvision(reborn)).status).toBe('received');
    expect((await service.executeProvision(OTHER_TENANT, 'reborn-1')).status).toBe('applied');
    expect(await service.getOverview(OTHER_TENANT)).toMatchObject({ slug: 'acme' });
  });
});
