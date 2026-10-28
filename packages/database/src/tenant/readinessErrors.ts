import { TenantDatabaseError } from './errors';

/** Secret-free wire reasons. Only typed failures may contribute a diagnostic. */
export const SAFE_READINESS_DIAGNOSTIC_CODES = [
  'TENANT_DIRECTORY_MISMATCH',
  'RUNTIME_ROLE_INVALID',
  'OWNER_PRIVILEGED',
  'OWNER_MISMATCH',
  'SCHEMA_NOT_OWNED',
  'CROSS_SCHEMA_USAGE',
  'RUNTIME_CAN_CREATE_SCHEMA',
  'RUNTIME_CAN_CREATE',
  'PUBLIC_TABLE_ACCESS',
  'PUBLIC_SEQUENCE_ACCESS',
  'RUNTIME_DML_MISSING',
  'MIGRATION_JOURNAL_ACCESS_INVALID',
  'SCHEMA_OBJECT_NOT_OWNED',
  'RUNTIME_SEQUENCE_ACCESS_MISSING',
  'MIGRATION_HISTORY_MISMATCH',
  'SCHEMA_NOT_PROVISIONED',
  'SCHEMA_VERSION_INCOMPATIBLE',
  'SCHEMA_NAME_INVALID',
  'DATASOURCE_BINDING_INVALID',
  'RUNTIME_CONNECTION_FAILED',
  'OWNER_CONNECTION_FAILED',
] as const;
export type SafeReadinessDiagnosticCode = (typeof SAFE_READINESS_DIAGNOSTIC_CODES)[number];

export const isSafeReadinessDiagnosticCode = (
  value: unknown,
): value is SafeReadinessDiagnosticCode =>
  typeof value === 'string' &&
  (SAFE_READINESS_DIAGNOSTIC_CODES as readonly string[]).includes(value);

export class TenantReadinessError extends Error {
  constructor(readonly diagnosticCode: SafeReadinessDiagnosticCode) {
    super(diagnosticCode);
    this.name = 'TenantReadinessError';
  }
}

export const readinessDiagnosticOf = (error: unknown): SafeReadinessDiagnosticCode | null => {
  if (error instanceof TenantReadinessError && isSafeReadinessDiagnosticCode(error.diagnosticCode))
    return error.diagnosticCode;
  if (error instanceof TenantDatabaseError) {
    switch (error.reason) {
      case 'migration-history-mismatch': {
        return 'MIGRATION_HISTORY_MISMATCH';
      }
      case 'schema-not-provisioned': {
        return 'SCHEMA_NOT_PROVISIONED';
      }
      case 'schema-version-incompatible': {
        return 'SCHEMA_VERSION_INCOMPATIBLE';
      }
      case 'schema-name-invalid': {
        return 'SCHEMA_NAME_INVALID';
      }
    }
  }
  return null;
};
