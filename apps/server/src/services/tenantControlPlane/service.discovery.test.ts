import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bundle,
  hooks,
  lifecycle,
  provision,
  provisionApplied,
  resetService,
  rotate,
  TENANT,
} from './__tests__/service.testUtils';
import { redactDatasourceBundle } from './datasource';

let repo: ReturnType<typeof resetService>['repo'];
let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ repo, db, service } = resetService());
});

describe('discovery recovery publication', () => {
  const active = () =>
    lifecycle({ desiredState: 'active', freezeReasons: [], eventId: 'restore', version: 2 });
  const freeze = () => lifecycle({ eventId: 'new-freeze', version: 3 });
  const prepare = async () => {
    await provisionApplied();
    await service.receiveLifecycle(lifecycle());
    db.migrate.mockClear();
    db.verify.mockClear();
    db.verifyDiscovery.mockClear();
    await service.receiveLifecycle(active());
  };
  it('keeps directory provisioning when special verification fails during provision', async () => {
    db.verifyDiscovery.mockRejectedValueOnce(new Error('lookup grant missing'));
    expect((await provisionApplied()).status).toBe('failed');
    expect(repo.directory.get(TENANT)?.record.status).toBe('provisioning');
    await service.receiveProvision(provision());
    expect((await service.executeProvision(TENANT, 'root-1:lobehub')).status).toBe('applied');
    expect(repo.directory.get(TENANT)?.record.status).toBe('active');
  });
  it.each(['frozen', 'offline', 'expired'] as const)(
    'accepts %s recovery without owner IO and retains an admission barrier until repair succeeds',
    async (state) => {
      await provisionApplied();
      await service.receiveLifecycle(
        lifecycle({
          desiredState: state === 'offline' ? 'offline' : state === 'frozen' ? 'frozen' : 'active',
          freezeReasons: state === 'frozen' ? ['manual'] : [],
          expiresAt: state === 'expired' ? '2020-01-01T00:00:00.000Z' : null,
        }),
      );
      db.migrate.mockClear();
      db.verifyDiscovery.mockClear();
      await expect(service.receiveLifecycle(active())).resolves.toMatchObject({
        status: 'received',
        acceptedVersion: 2,
      });
      expect(db.migrate).not.toHaveBeenCalled();
      expect(repo.directory.get(TENANT)?.record.status).toBe('provisioning');
      db.verifyDiscovery.mockRejectedValueOnce(new Error('grant repair failed'));
      expect(await service.executeLifecycle(TENANT, 'restore', hooks())).toMatchObject({
        status: 'failed',
        errorCode: 'LIFECYCLE_RESUME_FAILED',
      });
      expect(repo.directory.get(TENANT)?.record.status).toBe('provisioning');
      await service.receiveLifecycle(active());
      expect(await service.executeLifecycle(TENANT, 'restore', hooks())).toMatchObject({
        status: 'applied',
      });
      expect(repo.directory.get(TENANT)?.record.status).toBe('active');
      expect(db.migrate).toHaveBeenCalledTimes(2);
    },
  );
  it('does not repeat migration on first activation or an active renewal', async () => {
    await provisionApplied();
    db.migrate.mockClear();
    db.verifyDiscovery.mockClear();
    await service.receiveLifecycle(lifecycle({ desiredState: 'active', freezeReasons: [] }));
    await service.executeLifecycle(TENANT, 'evt-1', hooks());
    await service.receiveLifecycle(active());
    await service.executeLifecycle(TENANT, 'restore', hooks());
    expect(db.migrate).not.toHaveBeenCalled();
    expect(db.verifyDiscovery).not.toHaveBeenCalled();
  });
  it('cannot publish an old recovery when a new freeze arrives during verification', async () => {
    await prepare();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    db.verifyDiscovery.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
    });
    const restoring = service.executeLifecycle(TENANT, 'restore', hooks());
    await started.promise;
    await service.receiveLifecycle(freeze());
    finish.resolve();
    expect(await restoring).toMatchObject({ status: 'superseded' });
    expect(repo.directory.get(TENANT)?.record.status).toBe('provisioning');
    expect(repo.lifecycles.get(TENANT)?.desiredState).toBe('frozen');
  });
  it('does not reopen after a newer freeze arrives following publication but during resume', async () => {
    await prepare();
    const h = hooks();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    vi.mocked(h.resumeQueue).mockImplementationOnce(async () => {
      expect(repo.directory.get(TENANT)?.record.status).toBe('active');
      started.resolve();
      await finish.promise;
    });
    const restoring = service.executeLifecycle(TENANT, 'restore', h);
    await started.promise;
    await service.receiveLifecycle(freeze());
    finish.resolve();
    expect(await restoring).toMatchObject({ status: 'superseded' });
    expect(repo.lifecycles.get(TENANT)?.desiredState).toBe('frozen');
  });
  it('retries failed resume without rolling back already certified grants', async () => {
    await prepare();
    const h = hooks();
    vi.mocked(h.resumeQueue).mockRejectedValueOnce(new Error('resume failed'));
    expect(await service.executeLifecycle(TENANT, 'restore', h)).toMatchObject({
      status: 'failed',
    });
    expect(repo.directory.get(TENANT)?.record.status).toBe('active');
    await service.receiveLifecycle(active());
    expect(await service.executeLifecycle(TENANT, 'restore', hooks())).toMatchObject({
      status: 'applied',
    });
    expect(db.migrate).toHaveBeenCalledTimes(1);
  });
  it('rejects publication if credentials rotate during repair', async () => {
    await prepare();
    db.verifyDiscovery.mockImplementationOnce(async () => {
      await repo.transaction(TENANT, async (tx) => {
        const d = (await tx.getDirectory(TENANT))!;
        await tx.putDirectory(
          { ...d.record, connectionVersion: 2 },
          { ...d.bundle, connectionVersion: 2 },
        );
      });
    });
    expect(await service.executeLifecycle(TENANT, 'restore', hooks())).toMatchObject({
      status: 'failed',
    });
    expect(repo.directory.get(TENANT)?.record.status).toBe('provisioning');
  });
  it('does not let lookup readiness failure affect runtime readiness or credential rotation', async () => {
    await provisionApplied();
    db.verifyDiscovery.mockClear();
    db.verifyDiscovery.mockRejectedValue(new Error('lookup unavailable'));
    expect(
      await service.getDatasourceReadiness({
        tenantId: TENANT,
        datasource: redactDatasourceBundle(bundle()),
      }),
    ).toMatchObject({ datasourceReady: true });
    expect(await service.receiveDatasource(rotate())).toMatchObject({ status: 'applied' });
    expect(db.verifyDiscovery).not.toHaveBeenCalled();
  });
});
