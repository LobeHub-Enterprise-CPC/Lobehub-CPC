import { beforeEach, describe, expect, it } from 'vitest';

import {
  provision,
  provisionApplied,
  resetService,
  rotate,
  TENANT,
} from './__tests__/service.testUtils';

let repo: ReturnType<typeof resetService>['repo'];
let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ repo, db, service } = resetService());
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
      diagnosticCode: null,
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
