// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TenantDatabaseError } from './errors';
import {
  readinessDiagnosticOf,
  SAFE_READINESS_DIAGNOSTIC_CODES,
  TenantReadinessError,
} from './readinessErrors';

describe('safe readiness diagnostics', () => {
  it('matches the shared wire contract', () => {
    const file = fileURLToPath(
      new URL(
        './../../../../contracts/tenant-control-plane/readiness-diagnostic-codes.json',
        import.meta.url,
      ),
    );
    expect(SAFE_READINESS_DIAGNOSTIC_CODES).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });
  it('accepts typed known failures and refuses untrusted text and forged properties', () => {
    expect(readinessDiagnosticOf(new TenantReadinessError('CROSS_SCHEMA_USAGE'))).toBe(
      'CROSS_SCHEMA_USAGE',
    );
    expect(
      readinessDiagnosticOf(
        new TenantDatabaseError('TENANT_NOT_READY', 'migration-history-mismatch'),
      ),
    ).toBe('MIGRATION_HISTORY_MISMATCH');
    expect(readinessDiagnosticOf(new Error('CROSS_SCHEMA_USAGE'))).toBeNull();
    expect(readinessDiagnosticOf({ diagnosticCode: 'CROSS_SCHEMA_USAGE' })).toBeNull();
    expect(readinessDiagnosticOf(new TenantReadinessError('postgres://unsafe' as any))).toBeNull();
    expect(
      readinessDiagnosticOf(
        new TenantDatabaseError('TENANT_NOT_READY', 'postgres://unsafe' as any),
      ),
    ).toBeNull();
  });
});
