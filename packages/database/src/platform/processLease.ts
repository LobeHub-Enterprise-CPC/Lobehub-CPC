import { and, sql } from 'drizzle-orm';

import { tenantLifecycle, tenantRuntimeProcess } from './schemas';

/** SQL shared by stop polling and final lifecycle confirmation. NULL/missing receipts block. */
export const tenantLeaseBlocker = (tenantId: string) =>
  and(
    sql`${tenantRuntimeProcess.leaseExpiresAt} > statement_timestamp()`,
    sql`NOT COALESCE((${tenantRuntimeProcess.drainedGenerations} ->> ${tenantId})::integer =
    (SELECT ${tenantLifecycle.acceptedVersion} FROM ${tenantLifecycle} WHERE ${tenantLifecycle.tenantId} = ${tenantId}), false)`,
  );

/**
 * A process publishes this instead of a lifecycle generation for a tenant UUID that has a destruction
 * terminal and has no request pinned in that process. Real lifecycle versions are positive.
 */
export const TENANT_DESTROYED_GENERATION = -1;

/**
 * Destruction drain: a live process blocks until it has published {@link TENANT_DESTROYED_GENERATION}
 * for the tenant. Unlike {@link tenantLeaseBlocker} it does not depend on a lifecycle row, which a
 * tenant that was never provisioned (or whose rows are already unregistered) does not have.
 */
export const tenantDestroyBlocker = (tenantId: string) =>
  and(
    sql`${tenantRuntimeProcess.leaseExpiresAt} > statement_timestamp()`,
    sql`NOT COALESCE((${tenantRuntimeProcess.drainedGenerations} ->> ${tenantId})::integer = ${TENANT_DESTROYED_GENERATION}, false)`,
  );
