import { verifyPassword } from 'better-auth/crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NOW,
  provision,
  provisionApplied,
  resetService,
  TENANT,
} from './__tests__/service.testUtils';
import { tenantDbNames } from './datasource';
import { TenantControlPlaneService, type TenantDatabaseExecutor } from './service';

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
    expect(order).toEqual([
      'checkOwnership',
      'migrate',
      'seed',
      'verify',
      'verifyDiscovery',
      'verifyProvisionCapture',
    ]);
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
    ['verifyProvisionCapture', 'DATASOURCE_INVALID'],
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

  it('seeds with the name, slug and member budget the request carried, also when resumed', async () => {
    const memberBudget = { budgetDuration: null, maxBudget: 28.089888 };
    db.seed.mockRejectedValueOnce(new Error('boom'));
    await provisionApplied(provision({ memberBudget }));
    await service.receiveProvision(provision({ memberBudget }));
    await service.executeProvision(TENANT, 'root-1:lobehub');

    expect(db.seed).toHaveBeenCalledTimes(2);
    for (const [ctx] of db.seed.mock.calls)
      expect(ctx).toMatchObject({ memberBudget, name: 'Acme', slug: 'acme' });
  });

  it('seeds without a member budget when the request has none', async () => {
    await provisionApplied();
    expect(db.seed.mock.calls[0][0]).toMatchObject({ memberBudget: null });
  });

  it('refuses a retry that changes the member budget of the same operation', async () => {
    await service.receiveProvision(
      provision({ memberBudget: { budgetDuration: null, maxBudget: 1 } }),
    );
    await expect(
      service.receiveProvision(provision({ memberBudget: { budgetDuration: null, maxBudget: 2 } })),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  describe('initial Owner', () => {
    const bootstrapOwner = { email: 'owner@acme.com', name: 'Owner', password: 'Aa1!aaaaaaaa' };

    it('keeps only a hash of the Owner password, outside the operation record', async () => {
      await service.receiveProvision(provision({ bootstrapOwner }));

      const pending = repo.operationOwners.get('root-1:lobehub')!;
      expect(pending).toMatchObject({ email: 'owner@acme.com', name: 'Owner' });
      expect(pending.passwordHash).not.toContain(bootstrapOwner.password);
      expect(
        await verifyPassword({ hash: pending.passwordHash, password: bootstrapOwner.password }),
      ).toBe(true);
      expect(JSON.stringify([...repo.operations.values()])).not.toContain('owner@acme.com');
    });

    it('seeds the Owner, also when resumed, and drops it once applied', async () => {
      db.seed.mockRejectedValueOnce(new Error('boom'));
      await provisionApplied(provision({ bootstrapOwner }));
      const result = await provisionApplied(provision({ bootstrapOwner }));

      expect(result.status).toBe('applied');
      expect(db.seed).toHaveBeenCalledTimes(2);
      for (const [ctx] of db.seed.mock.calls)
        expect(ctx.bootstrapOwner).toMatchObject({ email: 'owner@acme.com', name: 'Owner' });
      expect(repo.operationOwners.size).toBe(0);
    });

    it('is not part of the operation identity: a retry may carry a corrected Owner', async () => {
      db.seed.mockRejectedValueOnce(new Error('boom'));
      await provisionApplied(provision({ bootstrapOwner }));
      await provisionApplied(provision({ bootstrapOwner: { ...bootstrapOwner, name: 'Fixed' } }));

      expect(db.seed.mock.calls[1][0].bootstrapOwner).toMatchObject({ name: 'Fixed' });
    });

    it('keeps the received Owner when a retry carries none', async () => {
      db.seed.mockRejectedValueOnce(new Error('boom'));
      await provisionApplied(provision({ bootstrapOwner }));
      await provisionApplied();

      expect(db.seed.mock.calls[1][0].bootstrapOwner).toMatchObject({ name: 'Owner' });
    });

    it('seeds no Owner when the request has none', async () => {
      await provisionApplied();
      expect(db.seed.mock.calls[0][0]).toMatchObject({ bootstrapOwner: null });
    });

    it('stores no Owner for a request that fails validation', async () => {
      await service.receiveProvision(provision({ bootstrapOwner, slug: 'admin' }));
      expect(repo.operationOwners.size).toBe(0);
    });
  });

  it('never puts the database error into the result', async () => {
    db.migrate.mockRejectedValueOnce(new Error('postgres://lh:owner-secret@host'));
    expect(JSON.stringify(await provisionApplied())).not.toContain('secret');
  });
});
