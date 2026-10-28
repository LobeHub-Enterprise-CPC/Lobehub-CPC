import { beforeEach, describe, expect, it } from 'vitest';

import { bundle, NOW, provisionApplied, resetService, TENANT } from './__tests__/service.testUtils';
import { redactDatasourceBundle } from './datasource';

let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ db, service } = resetService());
});

describe('current datasource readiness', () => {
  const request = (data = bundle()) => ({
    tenantId: TENANT,
    datasource: redactDatasourceBundle(data),
  });

  it('does not mark an unprovisioned bundle ready', async () => {
    expect(await service.getDatasourceReadiness(request())).toMatchObject({
      datasourceReady: false,
      errorCode: 'TENANT_NOT_READY',
    });
    expect(db.verify).not.toHaveBeenCalled();
  });

  it('verifies the current database without a provision operation ID', async () => {
    await provisionApplied();
    db.verify.mockClear();
    expect(await service.getDatasourceReadiness(request())).toMatchObject({
      datasourceReady: true,
      errorCode: null,
      checkedAt: NOW.toISOString(),
      connectionVersion: 1,
    });
    expect(db.verify).toHaveBeenCalledWith({ tenantId: TENANT, bundle: bundle() });
    db.verify.mockRejectedValueOnce(new Error('private connection error'));
    const failed = await service.getDatasourceReadiness(request());
    expect(failed).toMatchObject({ datasourceReady: false, errorCode: 'DATASOURCE_INVALID' });
    expect(JSON.stringify(failed)).not.toContain('private');
  });

  it.each([
    { host: 'other.internal' },
    { database: 'other' },
    { connectionVersion: 2 },
    { credentialBundleVersion: 2 },
  ])('rejects a mismatched current binding %j before opening a connection', async (change) => {
    await provisionApplied();
    db.verify.mockClear();
    expect(await service.getDatasourceReadiness(request(bundle(TENANT, change)))).toMatchObject({
      datasourceReady: false,
      errorCode: 'DATASOURCE_INVALID',
    });
    expect(db.verify).not.toHaveBeenCalled();
  });

  it('accepts the rotated bundle and refuses the previous binding without a new provision', async () => {
    await provisionApplied();
    const rotated = bundle(TENANT, { connectionVersion: 2, credentialBundleVersion: 2 });
    await service.receiveDatasource({
      tenantId: TENANT,
      operationId: 'rotation',
      datasource: rotated,
    });
    expect(await service.getDatasourceReadiness(request())).toMatchObject({
      datasourceReady: false,
    });
    expect(await service.getDatasourceReadiness(request(rotated))).toMatchObject({
      datasourceReady: true,
      connectionVersion: 2,
      credentialBundleVersion: 2,
    });
  });

  it('refuses a binding replaced while its verification is in flight', async () => {
    await provisionApplied();
    db.verify.mockImplementationOnce(async () => {
      await service.receiveDatasource({
        tenantId: TENANT,
        operationId: 'rotation',
        datasource: bundle(TENANT, { connectionVersion: 2, credentialBundleVersion: 2 }),
      });
    });
    expect(await service.getDatasourceReadiness(request())).toMatchObject({
      datasourceReady: false,
      errorCode: 'DATASOURCE_INVALID',
    });
  });
});
