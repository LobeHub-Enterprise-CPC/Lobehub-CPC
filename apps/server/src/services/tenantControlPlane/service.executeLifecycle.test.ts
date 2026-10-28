import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertConsoleInvariants,
  hooks,
  lifecycle,
  NOW,
  provision,
  provisionApplied,
  resetService,
  TENANT,
} from './__tests__/service.testUtils';
import { LifecycleFailure } from './contracts';
import { TenantControlPlaneService } from './service';

let repo: ReturnType<typeof resetService>['repo'];
let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ repo, db, service } = resetService());
});

describe('executeLifecycle', () => {
  beforeEach(async () => {
    await provisionApplied();
  });

  it('leases lifecycle work and ignores late failure after a replacement attempt completes', async () => {
    let now = NOW;
    const current = new TenantControlPlaneService({
      database: db,
      repository: repo,
      isRegistrableSlug: () => true,
      now: () => now,
    });
    await current.receiveLifecycle(lifecycle());
    const h = hooks();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    h.invalidateCaches = vi.fn().mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      throw new Error('late failure');
    });
    const first = current.executeLifecycle(TENANT, 'evt-1', h);
    await started.promise;
    expect((await current.executeLifecycle(TENANT, 'evt-1', hooks())).status).toBe('applying');
    now = new Date(NOW.getTime() + 10 * 60_000);
    expect((await current.executeLifecycle(TENANT, 'evt-1', hooks())).status).toBe('applied');
    release.resolve();
    expect((await first).status).toBe('applied');
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

  it('refuses applied if the final locked check still sees work, and retries after its receipt', async () => {
    await service.receiveLifecycle(lifecycle());
    repo.stopBlockers.set(TENANT, 'LIFECYCLE_STOP_UNCONFIRMED');
    const failed = await service.executeLifecycle(TENANT, 'evt-1', hooks());
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'LIFECYCLE_STOP_UNCONFIRMED',
      appliedVersion: 0,
    });
    repo.stopBlockers.delete(TENANT);
    expect(await service.executeLifecycle(TENANT, 'evt-1', hooks())).toMatchObject({
      status: 'applied',
      appliedVersion: 1,
    });
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
    expect(failed).toMatchObject({ errorCode: 'LIFECYCLE_DRAIN_FAILED', status: 'failed' });
    expect(repo.lifecycles.get(TENANT)!.desiredState).toBe('frozen');

    expect((await service.receiveLifecycle(lifecycle())).status).toBe('received');
    expect((await service.executeLifecycle(TENANT, 'evt-1', h)).status).toBe('applied');
  });

  it.each([
    ['closeRealtime', new Error('socket'), 'LIFECYCLE_STOP_FAILED'],
    ['stopQueue', new Error('queue'), 'LIFECYCLE_STOP_FAILED'],
    [
      'drainTransactions',
      new LifecycleFailure('LIFECYCLE_STOP_UNCONFIRMED'),
      'LIFECYCLE_STOP_UNCONFIRMED',
    ],
    ['invalidateCaches', new Error('cache'), 'LIFECYCLE_FAILED'],
  ] as const)('records a %s failure (%s) as %s', async (phase, error, errorCode) => {
    await service.receiveLifecycle(lifecycle());
    const h = hooks();
    (h[phase] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
    expect(await service.executeLifecycle(TENANT, 'evt-1', h)).toMatchObject({
      errorCode,
      status: 'failed',
    });
  });

  it('records a failed resume when activating', async () => {
    await service.receiveLifecycle(lifecycle({ desiredState: 'active', freezeReasons: [] }));
    const h = hooks();
    (h.resumeQueue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('resume'));
    expect(await service.executeLifecycle(TENANT, 'evt-1', h)).toMatchObject({
      errorCode: 'LIFECYCLE_RESUME_FAILED',
      status: 'failed',
    });
  });

  it('will not activate a tenant whose datasource is not ready', async () => {
    const other = 'tenant-b';
    await service.receiveProvision(
      provision({ operationId: 'b:lobehub', rootOperationId: 'b', slug: 'beta', tenantId: other }),
    );
    await service.receiveLifecycle(
      lifecycle({ desiredState: 'active', freezeReasons: [], tenantId: other }),
    );
    expect(await service.executeLifecycle(other, 'evt-1', hooks())).toMatchObject({
      errorCode: 'TENANT_NOT_READY',
      status: 'failed',
    });
    expect(repo.lifecycles.get(other)?.acceptedVersion).toBe(1);
  });
});
