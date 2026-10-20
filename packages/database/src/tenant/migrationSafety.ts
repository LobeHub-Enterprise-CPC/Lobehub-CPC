import { TenantDatabaseError } from './errors';
import { tenantMigrationSqlWithoutComments, tenantMigrationSqlWithoutData } from './migrationSql';

/** Shared by every tenant-chain runner, after schema materialization and before execution. */
export const assertTenantMigrationStatementSafe = (statement: string): void => {
  const sql = tenantMigrationSqlWithoutComments(statement);
  const code = tenantMigrationSqlWithoutData(statement);
  if (
    /"public"|(?<![\w"$.])public\s*\./i.test(code) ||
    // The whole chain runs in one transaction, which CONCURRENTLY cannot run in.
    /\b(?:(?:create\s+(?:unique\s+)?|drop\s+)index\s+concurrently|reindex[\s(][^;]*?\bconcurrently)\b/i.test(
      code,
    ) ||
    /\bcreate\s+(?:schema|extension)\b/i.test(sql) ||
    /\bset\s+(?:local\s+|session\s+)?(?:search_path|role|session\s+authorization)\b/i.test(sql) ||
    /\bset_config\s*\(\s*'search_path'/i.test(sql) ||
    /\bset\s+schema\b/i.test(sql) ||
    /\b(?:alter|drop)\s+(?:database|extension|schema)\b/i.test(sql)
  ) {
    // Do not include SQL in the public error: migrations can contain private deployment values.
    throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-failed');
  }
};
