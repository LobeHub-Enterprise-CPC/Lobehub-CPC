import { beforeEach, describe, expect, it } from 'vitest';

import {
  bundle,
  makeService,
  provision,
  provisionApplied,
  resetService,
  TENANT,
} from './__tests__/service.testUtils';
import type { DatasourceBundle } from './contracts';

let repo: ReturnType<typeof resetService>['repo'];
let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ repo, db, service } = resetService());
});

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
