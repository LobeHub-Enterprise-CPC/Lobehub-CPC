import type { Client } from 'pg';

import type { TenantUpgradeResult } from '../../apps/server/src/services/tenantControlPlane/upgrade';
import { isSafeReadinessDiagnosticCode } from '../../packages/database/src/tenant/readinessErrors';

// One session lock for the platform and tenant chains, including across releases.
// Use a pinned connection: acquiring/unlocking through a pool can use different sessions.
const STARTUP_LOCK = [1280262725, 1];

/** The migration journals are the durable release receipt, including distribution chains. */
export const migrateUnlessReady = async (
  verify: () => Promise<void>,
  migrate: () => Promise<void>,
) => {
  try {
    await verify();
  } catch {
    await migrate();
  }
};

interface StartupMigrationOptions {
  client: Pick<Client, 'query'>;
  migratePlatform: () => Promise<void>;
  report: (event: Record<string, number | string>) => void;
  upgradeTenants: () => Promise<TenantUpgradeResult>;
}

/** Platform failures reject; a failed tenant is reported and the others are still migrated. */
export const runStartupMigrations = async ({
  client,
  migratePlatform,
  report,
  upgradeTenants,
}: StartupMigrationOptions): Promise<TenantUpgradeResult> => {
  await client.query('SELECT pg_advisory_lock($1, $2)', STARTUP_LOCK);
  try {
    await migratePlatform();
    const result = await upgradeTenants();
    for (const { reason, tenantId } of result.failed) {
      // Leave Console-owned lifecycle state untouched: a rerun of the migration
      // repairs the tenant without a control-plane status change.
      report({
        event: 'tenant_migration_unavailable',
        reason:
          isSafeReadinessDiagnosticCode(reason) ||
          ['NOT_FOUND', 'PG_SEARCH_NOT_READY'].includes(reason) ||
          /^[A-Z0-9]{5}$/.test(reason)
            ? reason
            : 'TENANT_MIGRATION_FAILED',
        tenantId,
      });
    }
    report({
      event: 'tenant_migration_summary',
      ready: result.migrated.length,
      unavailable: result.failed.length,
    });
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', STARTUP_LOCK);
  }
};
