import { and, sql } from 'drizzle-orm';

import { tenantLifecycle, tenantRuntimeProcess } from './schemas';

/** SQL shared by stop polling and final lifecycle confirmation. NULL/missing receipts block. */
export const tenantLeaseBlocker = (tenantId: string) =>
  and(
    sql`${tenantRuntimeProcess.leaseExpiresAt} > statement_timestamp()`,
    sql`NOT COALESCE((${tenantRuntimeProcess.drainedGenerations} ->> ${tenantId})::integer =
    (SELECT ${tenantLifecycle.acceptedVersion} FROM ${tenantLifecycle} WHERE ${tenantLifecycle.tenantId} = ${tenantId}), false)`,
  );
