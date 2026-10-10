/**
 * Why a tenant database could not be used. The code is what callers turn
 * into a response (spec FR-DI-03); `reason` is for logs only and never names
 * a host, user or password.
 */
export type TenantDatabaseErrorCode = 'TENANT_NOT_READY' | 'TENANT_REQUIRED' | 'TENANT_UNAVAILABLE';

export type TenantDatabaseErrorReason =
  | 'capacity'
  | 'connect-failed'
  | 'connection-released'
  | 'decrypt-failed'
  | 'directory-miss'
  | 'kind-mismatch'
  | 'marker-mismatch'
  | 'marker-missing'
  | 'migration-failed'
  | 'no-scope'
  | 'pool-closed'
  | 'schema-name-invalid'
  | 'schema-not-provisioned'
  | 'schema-version-incompatible'
  | 'stale-connection-version'
  | 'status-not-active';

export class TenantDatabaseError extends Error {
  constructor(
    readonly code: TenantDatabaseErrorCode,
    readonly reason: TenantDatabaseErrorReason,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${reason}`, options);
    this.name = 'TenantDatabaseError';
  }
}
