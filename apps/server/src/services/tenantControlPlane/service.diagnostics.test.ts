import { TenantDatabaseError } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bundle,
  provision,
  provisionApplied,
  resetService,
  rotate,
  TENANT,
} from './__tests__/service.testUtils';
import { redactDatasourceBundle } from './datasource';

let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ db, service } = resetService());
});

describe('safe readiness diagnostics', () => {
  it('persists a trusted migration diagnostic across query and clears it on successful retry', async () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.verify.mockRejectedValueOnce(
        new TenantDatabaseError('TENANT_NOT_READY', 'migration-history-mismatch'),
      );
      expect(await provisionApplied()).toMatchObject({
        errorCode: 'DATASOURCE_INVALID',
        diagnosticCode: 'MIGRATION_HISTORY_MISMATCH',
        status: 'failed',
      });
      expect(await service.getProvision(TENANT, 'root-1:lobehub')).toMatchObject({
        diagnosticCode: 'MIGRATION_HISTORY_MISMATCH',
      });
      expect(JSON.stringify(logged.mock.calls)).toContain('MIGRATION_HISTORY_MISMATCH');
      await service.receiveProvision(provision());
      expect(await service.executeProvision(TENANT, 'root-1:lobehub')).toMatchObject({
        diagnosticCode: null,
        status: 'applied',
      });
    } finally {
      logged.mockRestore();
    }
  });
  it('returns a trusted diagnostic for current readiness and rotated credentials', async () => {
    await provisionApplied();
    db.verify.mockRejectedValueOnce(
      new TenantDatabaseError('TENANT_NOT_READY', 'schema-not-provisioned'),
    );
    expect(
      await service.getDatasourceReadiness({
        tenantId: TENANT,
        datasource: redactDatasourceBundle(bundle()),
      }),
    ).toMatchObject({ errorCode: 'DATASOURCE_INVALID', diagnosticCode: 'SCHEMA_NOT_PROVISIONED' });
    db.verify.mockRejectedValueOnce(
      new TenantDatabaseError('TENANT_NOT_READY', 'migration-history-mismatch'),
    );
    expect(await service.receiveDatasource(rotate())).toMatchObject({
      errorCode: 'DATASOURCE_INVALID',
      diagnosticCode: 'MIGRATION_HISTORY_MISMATCH',
    });
    expect(await service.receiveDatasource(rotate())).toMatchObject({
      diagnosticCode: null,
      status: 'applied',
    });
  });
  it('does not trust a diagnostic-looking Error.message or property', async () => {
    await provisionApplied();
    const secret = 'postgres://fixture:private-password@private-host/db';
    const fake = Object.assign(new Error(secret), { diagnosticCode: 'CROSS_SCHEMA_USAGE' });
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.verify.mockRejectedValueOnce(fake);
      const failed = await service.receiveDatasource(rotate());
      expect(failed).toMatchObject({ errorCode: 'DATASOURCE_INVALID', diagnosticCode: null });
      expect(JSON.stringify([failed, logged.mock.calls])).not.toContain(secret);
    } finally {
      logged.mockRestore();
    }
  });
});
