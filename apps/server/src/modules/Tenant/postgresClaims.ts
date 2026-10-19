import {
  getPlatformDB,
  tenantLeaseBlocker,
  tenantLifecycle,
  tenantRuntimeExternalWork,
  tenantRuntimeProcess,
} from '@lobechat/database/platform';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { TenantClaims } from './claims';
import { LifecycleFailure } from './lifecycleFailure';
import { TENANT_PROCESS_LEASE_MS, TenantProcessLease } from './processLease';
import { getTenantRuntime } from './runtime';

let observedGenerations = new Map<string, string>();

/** Each heartbeat observes Console's generations before invalidating local admission snapshots. */
export const tenantProcessLease = new TenantProcessLease({
  async renew(processId) {
    const db = getPlatformDB();
    await db.transaction(async (tx) => {
      const lifecycles = await tx.select().from(tenantLifecycle);
      const drainedGenerations: Record<string, number> = {};
      const observed = new Map<string, string>();
      for (const lifecycle of lifecycles) {
        const fingerprint = JSON.stringify(lifecycle);
        observed.set(lifecycle.tenantId, fingerprint);
        if (observedGenerations.get(lifecycle.tenantId) !== fingerprint)
          getTenantRuntime().invalidate(lifecycle.tenantId);
        const stopped =
          lifecycle.desiredState !== 'active' ||
          lifecycle.freezeReasons.length > 0 ||
          (lifecycle.expiresAt !== null && lifecycle.expiresAt.getTime() <= Date.now());
        if (stopped && !tenantClaims.isHeld(lifecycle.tenantId))
          drainedGenerations[lifecycle.tenantId] = lifecycle.acceptedVersion;
      }
      observedGenerations = observed;
      await tx
        .insert(tenantRuntimeProcess)
        .values({
          processId,
          drainedGenerations,
          heartbeatAt: sql`statement_timestamp()`,
          leaseExpiresAt: sql`statement_timestamp() + ${TENANT_PROCESS_LEASE_MS} * interval '1 millisecond'`,
        })
        .onConflictDoUpdate({
          target: tenantRuntimeProcess.processId,
          set: {
            drainedGenerations,
            heartbeatAt: sql`statement_timestamp()`,
            leaseExpiresAt: sql`statement_timestamp() + ${TENANT_PROCESS_LEASE_MS} * interval '1 millisecond'`,
          },
        });
      await tx
        .delete(tenantRuntimeProcess)
        .where(sql`${tenantRuntimeProcess.leaseExpiresAt} <= statement_timestamp()`);
    });
  },
  async remove(processId) {
    await getPlatformDB()
      .delete(tenantRuntimeProcess)
      .where(eq(tenantRuntimeProcess.processId, processId));
  },
});

export const tenantClaims = new TenantClaims(
  () => tenantProcessLease.ensure(),
  () => tenantProcessLease.assertValid(),
);

/** Resource watchers check local lease authority; the timer alone renews it. */
export const heartbeatTenantProcess = async () => {
  await tenantProcessLease.ensure();
};

/** Expired processes cannot block confirmation; every live process must acknowledge this generation. */
export const waitForTenantClaims = async (
  tenantId: string,
  timeoutMs = 60_000,
  db = getPlatformDB(),
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = await db
      .select({ processId: tenantRuntimeProcess.processId })
      .from(tenantRuntimeProcess)
      .where(tenantLeaseBlocker(tenantId))
      .limit(1);
    const remote = await db
      .select({ id: tenantRuntimeExternalWork.workId })
      .from(tenantRuntimeExternalWork)
      .where(
        and(
          eq(tenantRuntimeExternalWork.tenantId, tenantId),
          isNull(tenantRuntimeExternalWork.completedAt),
        ),
      )
      .limit(1);
    if (!remaining.length && !remote.length) return;
    if (Date.now() >= deadline) throw new LifecycleFailure('LIFECYCLE_STOP_UNCONFIRMED');
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
};
