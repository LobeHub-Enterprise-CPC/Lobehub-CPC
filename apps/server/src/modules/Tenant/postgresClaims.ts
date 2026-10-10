import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import {
  getPlatformDB,
  tenantDirectory,
  tenantLifecycle,
  tenantRuntimeClaim,
  tenantRuntimeCutover,
  tenantRuntimeExternalWork,
  tenantRuntimeProcess,
} from '@lobechat/database/platform';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { TenantClaims } from './claims';
import { TenantGateError } from './errors';
import { readProcessIdentity } from './processIdentity';

const processId = randomUUID();
const register = () =>
  getPlatformDB()
    .insert(tenantRuntimeProcess)
    .values({
      processId,
      host: hostname(),
      pid: process.pid,
      ...readProcessIdentity(),
    })
    .onConflictDoNothing()
    .then(() => undefined);

export const tenantClaims = new TenantClaims({
  async acquire(tenantId, claimToken) {
    await register();
    await getPlatformDB().transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`lobehub:tenant-control:${tenantId}`}, 0))`,
      );
      const [owner] = await tx
        .select()
        .from(tenantRuntimeProcess)
        .where(eq(tenantRuntimeProcess.processId, processId));
      if (owner?.state !== 'running') throw new TenantGateError('TENANT_UNAVAILABLE');
      const [row] = await tx
        .select({ directory: tenantDirectory, lifecycle: tenantLifecycle })
        .from(tenantDirectory)
        .leftJoin(tenantLifecycle, eq(tenantDirectory.tenantId, tenantLifecycle.tenantId))
        .where(eq(tenantDirectory.tenantId, tenantId));
      if (!row || row.directory.status !== 'active' || !row.lifecycle?.acceptedVersion)
        throw new TenantGateError('TENANT_NOT_READY');
      const lifecycle = row.lifecycle;
      if (lifecycle.desiredState === 'offline') throw new TenantGateError('TENANT_OFFLINE');
      if (
        lifecycle.desiredState === 'frozen' ||
        lifecycle.freezeReasons.some((reason) => reason !== 'expired')
      )
        throw new TenantGateError('TENANT_FROZEN');
      if (lifecycle.expiresAt && lifecycle.expiresAt.getTime() <= Date.now())
        throw new TenantGateError('TENANT_EXPIRED');
      await tx
        .insert(tenantRuntimeClaim)
        .values({ tenantId, processId, claimToken, claimedVersion: lifecycle.acceptedVersion })
        .onConflictDoUpdate({
          target: [tenantRuntimeClaim.tenantId, tenantRuntimeClaim.processId],
          set: { claimToken, claimedVersion: lifecycle.acceptedVersion, claimedAt: sql`now()` },
        });
    });
  },
  async release(tenantId, claimToken) {
    await getPlatformDB()
      .delete(tenantRuntimeClaim)
      .where(
        and(
          eq(tenantRuntimeClaim.tenantId, tenantId),
          eq(tenantRuntimeClaim.processId, processId),
          eq(tenantRuntimeClaim.claimToken, claimToken),
        ),
      );
  },
});

export const heartbeatTenantProcess = async () => {
  await register();
  const rows = await getPlatformDB()
    .update(tenantRuntimeProcess)
    .set({ heartbeatAt: sql`now()` })
    .where(
      and(eq(tenantRuntimeProcess.processId, processId), eq(tenantRuntimeProcess.state, 'running')),
    )
    .returning();
  if (rows.length !== 1) throw new TenantGateError('TENANT_UNAVAILABLE');
};

/** No TTL can turn absence of acknowledgement into success. */
export const waitForTenantClaims = async (
  tenantId: string,
  timeoutMs = 60_000,
  db = getPlatformDB(),
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [cutover] = await db
      .select()
      .from(tenantRuntimeCutover)
      .where(eq(tenantRuntimeCutover.id, 'strict-stop'));
    if (!cutover?.enforcedAt) throw new Error('TENANT_STRICT_STOP_CUTOVER_REQUIRED');
    const remaining = await db
      .select({ processId: tenantRuntimeClaim.processId })
      .from(tenantRuntimeClaim)
      .where(eq(tenantRuntimeClaim.tenantId, tenantId))
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
    if (Date.now() >= deadline) throw new Error('TENANT_WORK_STOP_UNCONFIRMED');
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
};
