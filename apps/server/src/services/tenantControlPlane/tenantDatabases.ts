import type { PlatformDatabase } from '@lobechat/database/platform';
import { tenantDirectory } from '@lobechat/database/platform';
import {
  isTenantSchemaName,
  TENANT_EXTENSION_SCHEMAS,
  tenantHash,
} from '@lobechat/database/tenant';
import { asc, eq, inArray } from 'drizzle-orm';
import type { ClientConfig } from 'pg';

import { bundleClientConfig } from './postgresExecutor';
import { bundleFromDirectoryRow } from './postgresRepository';

export interface TenantDatabaseTarget {
  /**
   * Connection to the tenant database with the tenant schema first on its
   * `search_path`, so unqualified SQL (the repositories, the capture
   * installer, the reindex) reads and writes the tenant's tables.
   */
  clientConfig: ClientConfig;
  /** First 24 hex chars of sha256(tenantId); names the tenant's schema and roles. */
  h24: string;
  schemaName: string;
  slug: string;
  tenantId: string;
}

export interface ListTenantDatabasesOptions {
  /** `owner` for DDL (capture triggers), `runtime` for reads and writes. */
  role: 'owner' | 'runtime';
  /** Only these tenants; every active tenant when omitted or empty. */
  tenantIds?: string[];
}

/**
 * Tenant databases from the platform directory, for the per-tenant operator
 * jobs (FTS capture install, Elasticsearch reindex). Credentials are opened
 * here and never printed. Requested tenants that the directory does not know
 * are returned in `missing`.
 */
export const listTenantDatabases = async (
  platformDB: PlatformDatabase,
  { role, tenantIds }: ListTenantDatabasesOptions,
): Promise<{ missing: string[]; targets: TenantDatabaseTarget[] }> => {
  const rows = await platformDB
    .select()
    .from(tenantDirectory)
    .where(
      tenantIds?.length
        ? inArray(tenantDirectory.tenantId, tenantIds)
        : eq(tenantDirectory.status, 'active'),
    )
    .orderBy(asc(tenantDirectory.tenantId));

  const found = new Set(rows.map((row) => row.tenantId));
  for (const row of rows)
    if (!isTenantSchemaName(row.schemaName)) throw new Error('TENANT_SCHEMA_NAME_INVALID');
  return {
    missing: (tenantIds ?? []).filter((tenantId) => !found.has(tenantId)),
    targets: rows.map((row) => ({
      clientConfig: {
        ...bundleClientConfig(bundleFromDirectoryRow(row), role),
        options: `-c search_path=${[row.schemaName, ...TENANT_EXTENSION_SCHEMAS].join(',')}`,
      },
      h24: tenantHash(row.tenantId),
      schemaName: row.schemaName,
      slug: row.slug,
      tenantId: row.tenantId,
    })),
  };
};

/** `--tenant <id>` / `--tenant=<id>` (repeatable), as `db:migrate` takes them. */
export const parseTenantArguments = (argv: string[]) => {
  const ids: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--tenant' && argv[index + 1]) ids.push(argv[++index]);
    else if (argv[index].startsWith('--tenant=')) ids.push(argv[index].slice('--tenant='.length));
  }
  return ids;
};
