import { getPlatformDB, tenantRuntimeExternalWork } from '@lobechat/database/platform';
import { currentTenantScope } from '@lobechat/database/tenant';
import { and, eq, isNull } from 'drizzle-orm';

import { tenantClaims } from './postgresClaims';

/** Register before submission: a lost response must not be mistaken for a cancelled job. */
export const beginExternalTenantWork = async (
  kind: string,
  id: string,
  context?: Record<string, unknown>,
) => {
  const tenantId = currentTenantScope()?.tenantId;
  if (!tenantId) return;
  const release = await tenantClaims.enter(tenantId);
  try {
    await getPlatformDB()
      .insert(tenantRuntimeExternalWork)
      .values({ workId: `${kind}:${id}`, tenantId, kind, context })
      .onConflictDoNothing();
  } finally {
    await release();
  }
};

/** Called only on a provider's positive terminal observation, never on a timeout/error. */
export const confirmExternalTenantWork = async (
  kind: string,
  id: string,
  receipt?: Record<string, unknown>,
) => {
  const tenantId = currentTenantScope()?.tenantId;
  if (!tenantId) return;
  await getPlatformDB()
    .update(tenantRuntimeExternalWork)
    .set({ completedAt: new Date(), receipt: { source: 'provider-terminal', ...receipt } })
    .where(
      and(
        eq(tenantRuntimeExternalWork.workId, `${kind}:${id}`),
        isNull(tenantRuntimeExternalWork.completedAt),
        eq(tenantRuntimeExternalWork.tenantId, tenantId),
      ),
    );
};

export const identifyExternalTenantWork = async (
  kind: string,
  id: string,
  handle: string,
  context?: Record<string, unknown>,
) => {
  const tenantId = currentTenantScope()?.tenantId;
  if (!tenantId) return;
  await getPlatformDB()
    .update(tenantRuntimeExternalWork)
    .set({ handle, ...(context && { context }) })
    .where(
      and(
        eq(tenantRuntimeExternalWork.workId, `${kind}:${id}`),
        eq(tenantRuntimeExternalWork.tenantId, tenantId),
      ),
    );
};

/** A normal status consumer may also provide the positive terminal receipt. */
export const confirmExternalTenantHandle = async (kind: string, handle: string) => {
  const tenantId = currentTenantScope()?.tenantId;
  if (!tenantId) return;
  await getPlatformDB()
    .update(tenantRuntimeExternalWork)
    .set({ completedAt: new Date(), receipt: { source: 'provider-terminal' } })
    .where(
      and(
        eq(tenantRuntimeExternalWork.kind, kind),
        isNull(tenantRuntimeExternalWork.completedAt),
        eq(tenantRuntimeExternalWork.handle, handle),
        eq(tenantRuntimeExternalWork.tenantId, tenantId),
      ),
    );
};
