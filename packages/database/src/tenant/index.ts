// Named re-exports, not `export *`: this package is CommonJS, and an ES module
// importing it (the tsx-run `db:migrate`, apps/server is `type: module`) only
// sees names Node's CJS lexer can detect. `export *` compiles to a runtime
// re-export the lexer cannot read, which drops every name from the import.
export type { TenantDatabaseErrorCode, TenantDatabaseErrorReason } from './errors';
export { TenantDatabaseError } from './errors';
export type {
  RunTenantMigrationsOptions,
  TenantMigrationContext,
  TenantMigrator,
} from './migrator';
export {
  getTenantMigrators,
  materializeTenantMigrations,
  materializeTenantStatement,
  migrateTenantSchema,
  registerTenantMigrator,
  resolveTenantMigrationsFolder,
  runTenantMigrations,
  TENANT_MIGRATIONS_TABLE,
  TENANT_ONLY_MIGRATIONS_TABLE,
  verifyTenantMigrationHistory,
} from './migrator';
export {
  isTenantSchemaName,
  LOBEHUB_TENANT_SCHEMA_VERSION,
  SUPPORTED_TENANT_SCHEMA_VERSIONS,
  TENANT_EXTENSION_OWNED_SCHEMAS,
  TENANT_EXTENSION_SCHEMAS,
  tenantDbNames,
  tenantDrainLockKey,
  tenantFtsSearchNamespace,
  tenantHash,
  tenantSearchPathSql,
  tenantTransactionPreludeSql,
} from './names';
export type {
  TenantConnectionTarget,
  TenantPoolConfig,
  TenantPoolLease,
  TenantPoolManagerOptions,
  TenantPoolPurpose,
} from './pool';
export { fingerprintConnection, TenantPoolManager } from './pool';
export { verifyTenantRuntime } from './readiness';
export type { TenantScope } from './requestScope';
export {
  currentTenantScope,
  requireTenantScope,
  runWithTenantScope,
  tenantDB,
  trackTenantWork,
} from './requestScope';
export type { TenantDatabaseSessionConfig } from './session';
export { createTenantSchemaPool, TenantDatabaseSession } from './session';
