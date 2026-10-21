import type { PlatformDatabase } from '@lobechat/database/platform';
import { tenantDestruction, tenantDirectory } from '@lobechat/database/platform';
import { LOBEHUB_TENANT_SCHEMA_VERSION } from '@lobechat/database/tenant';
import { and, asc, eq, inArray, notExists } from 'drizzle-orm';

import { PostgresTenantDatabaseExecutor } from './postgresExecutor';
import { bundleFromDirectoryRow } from './postgresRepository';

export interface TenantUpgradeResult {
  failed: { reason: string; tenantId: string }[];
  migrated: string[];
}

export interface UpgradeTenantSchemasOptions {
  executor?: Pick<PostgresTenantDatabaseExecutor, 'migrate' | 'verify' | 'verifyDiscovery'>;
  /** Only these tenants; every active tenant when omitted. */
  tenantIds?: string[];
}

/**
 * Deploy-time upgrade of provisioned tenants (spec FR-MD-02): every tenant
 * chain (OSS first, then registered post-OSS chains) runs on each active
 * tenant as its schema owner, then the directory moves to this
 * build's schema version, then the runtime self-check. Tenants are
 * migrated one at a time and a failure does not stop the others; the caller
 * reports the failures. Credentials come from the directory and are never
 * printed.
 */
export const upgradeTenantSchemas = async (
  platformDB: PlatformDatabase,
  { executor = new PostgresTenantDatabaseExecutor(), tenantIds }: UpgradeTenantSchemasOptions = {},
): Promise<TenantUpgradeResult> => {
  const rows = await platformDB
    .select()
    .from(tenantDirectory)
    .where(
      and(
        tenantIds?.length
          ? inArray(tenantDirectory.tenantId, tenantIds)
          : eq(tenantDirectory.status, 'active'),
        // A tenant under destruction is neither upgraded nor handed to an operator job.
        notExists(
          platformDB
            .select({ id: tenantDestruction.tenantId })
            .from(tenantDestruction)
            .where(eq(tenantDestruction.tenantId, tenantDirectory.tenantId)),
        ),
      ),
    )
    .orderBy(asc(tenantDirectory.tenantId));

  const result: TenantUpgradeResult = { failed: [], migrated: [] };
  const found = new Set(rows.map((row) => row.tenantId));
  for (const tenantId of tenantIds ?? [])
    if (!found.has(tenantId)) result.failed.push({ reason: 'NOT_FOUND', tenantId });

  for (const row of rows) {
    try {
      const bundle = {
        ...bundleFromDirectoryRow(row),
        schemaVersion: LOBEHUB_TENANT_SCHEMA_VERSION,
      };
      const ctx = {
        bundle,
        name: row.name,
        operationId: `upgrade:${row.tenantId}`,
        slug: row.slug,
        tenantId: row.tenantId,
      };
      await executor.migrate(ctx);
      await executor.verify({ bundle, tenantId: row.tenantId });
      await executor.verifyDiscovery({ bundle, tenantId: row.tenantId });
      if (row.schemaVersion !== LOBEHUB_TENANT_SCHEMA_VERSION) {
        await platformDB
          .update(tenantDirectory)
          .set({ schemaVersion: LOBEHUB_TENANT_SCHEMA_VERSION })
          .where(eq(tenantDirectory.tenantId, row.tenantId));
      }
      result.migrated.push(row.tenantId);
    } catch (error) {
      // Only the error code: server messages may quote connection details.
      const code = (error as { code?: string })?.code;
      result.failed.push({
        reason: code ?? (error instanceof Error ? error.message.slice(0, 64) : 'UNKNOWN'),
        tenantId: row.tenantId,
      });
    }
  }

  return result;
};
