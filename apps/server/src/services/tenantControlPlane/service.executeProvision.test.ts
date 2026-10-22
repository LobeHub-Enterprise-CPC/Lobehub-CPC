import { beforeEach, describe, expect, it } from 'vitest';

import {
  NOW,
  provision,
  provisionApplied,
  resetService,
  TENANT,
} from './__tests__/service.testUtils';
import { tenantDbNames } from './datasource';
import { TenantControlPlaneService } from './service';

let repo: ReturnType<typeof resetService>['repo'];
let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ repo, db, service } = resetService());
});

describe('executeProvision', () => {
  it('does not execute an operation already leased by another executor', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    db.migrate.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    await service.receiveProvision(provision());
    const first = service.executeProvision(TENANT, 'root-1:lobehub');
    await started.promise;
    try {
      expect((await service.executeProvision(TENANT, 'root-1:lobehub')).status).toBe('applying');
      expect(db.migrate).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await first;
    }
  });

  it('does not let an expired executor overwrite a newer completed attempt', async () => {
    let now = NOW;
    const current = new TenantControlPlaneService({
      database: db,
      repository: repo,
      isRegistrableSlug: () => true,
      now: () => now,
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    db.checkOwnership.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      throw new Error('late failure');
    });
    await current.receiveProvision(provision());
    const first = current.executeProvision(TENANT, 'root-1:lobehub');
    await started.promise;
    now = new Date(NOW.getTime() + 10 * 60_000);
    expect((await current.executeProvision(TENANT, 'root-1:lobehub')).status).toBe('applied');
    release.resolve();
    expect((await first).status).toBe('applied');
    expect((await current.getProvision(TENANT, 'root-1:lobehub')).status).toBe('applied');
  });

  it('runs every step in order, registers the directory and reports applied', async () => {
    const order: string[] = [];
    for (const [name, fn] of Object.entries(db))
      fn.mockImplementation(async () => void order.push(name));

    const result = await provisionApplied();
    expect(order).toEqual(['checkOwnership', 'migrate', 'seed', 'verify', 'verifyDiscovery']);
    expect(result).toEqual({
      credentialBundleVersion: 1,
      datasourceReady: true,
      diagnosticCode: null,
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
    ['seed', 'TENANT_PROVISION_FAILED'],
    ['verify', 'DATASOURCE_INVALID'],
    ['verifyDiscovery', 'DATASOURCE_INVALID'],
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
