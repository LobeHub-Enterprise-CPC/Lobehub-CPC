import type { tenantLifecycle } from '@lobechat/database/platform';

type LifecycleRow = typeof tenantLifecycle.$inferSelect;
type FreezeReason = LifecycleRow['freezeReasons'][number];
type TenantState = LifecycleRow['desiredState'];

/**
 * offline > frozen > active. Expiry is evaluated against `now` on every call,
 * so a tenant locks at `expiresAt` even if Console's `expired` event is late.
 */
export const effectiveTenantState = (
  lifecycle: { desiredState: TenantState; expiresAt: string | null; freezeReasons: FreezeReason[] },
  now: Date,
): { reasons: FreezeReason[]; state: TenantState } => {
  const reasons: FreezeReason[] = lifecycle.freezeReasons.filter((reason) => reason !== 'expired');
  if (lifecycle.expiresAt && Date.parse(lifecycle.expiresAt) <= now.getTime())
    reasons.push('expired');
  if (lifecycle.desiredState === 'offline') return { reasons, state: 'offline' };
  if (lifecycle.desiredState === 'frozen' || reasons.length > 0)
    return { reasons, state: 'frozen' };
  return { reasons, state: 'active' };
};
