import { getTenantDiscoveryConfig } from '@lobechat/env/tenantDiscovery';

import { discoveryAdmission, withDiscoveryDeadline } from './admission';
import { loadDiscoveryCandidates } from './candidates';
import { withLookupClient } from './connection';
import { queryTenantMembership } from './query';

/** Long enough for a healthy lookup, short enough not to hold up a sign-in or a refresh. */
const LOOKUP_BUDGET_MS = 1000;

/**
 * Whether an account email can enter an organization other than the current one.
 *
 * This is the organization-finder lookup run in process: the same eligible-candidate rules and
 * completeness checks (`loadDiscoveryCandidates`), the same read-only lookup role
 * (`withLookupClient`) and the same concurrency gate (`discoveryAdmission`). It bypasses only the
 * public HTTP endpoint and its rate limits, and works to a much shorter deadline.
 *
 * It never queues for the gate (`tryRun`): when the gate is busy the answer is simply unknown, so
 * optional sign-in decoration cannot take queue room from people using the finder. `signal` lets
 * the caller cancel the database work it gave up waiting for.
 *
 * The answer is display-only. Anything short of a complete answer (unconfigured lookup role, no
 * email, an incomplete candidate set, a failure, a timeout) is `undefined`, never `false`.
 */
export const hasOtherOrganizations = async (
  email: string | null | undefined,
  currentTenantId: string,
  { signal: callerSignal }: { signal?: AbortSignal } = {},
): Promise<boolean | undefined> => {
  // Same normalization as the finder's request schema.
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!getTenantDiscoveryConfig().ACCOUNT_LOOKUP_DATABASE_URL) return undefined;

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), LOOKUP_BUDGET_MS);
  const giveUp = () => budget.abort();
  callerSignal?.addEventListener('abort', giveUp, { once: true });
  if (callerSignal?.aborted) giveUp();
  try {
    return await withDiscoveryDeadline(budget.signal, (signal) =>
      discoveryAdmission.tryRun(signal, async () => {
        // A candidate set that is incomplete anywhere throws here, current tenant or not.
        const candidates = await loadDiscoveryCandidates(signal);
        signal.throwIfAborted();
        const others = candidates.filter(({ id }) => id !== currentTenantId);
        const found = await withLookupClient(signal, (client) =>
          queryTenantMembership(client, others, normalized),
        );
        return found.some(({ id }) => id !== currentTenantId);
      }),
    );
  } catch {
    // Never log the cause: connection errors can carry DSNs and queries can carry the email.
    console.warn('TENANT_DISCOVERY_OTHER_ORGANIZATIONS_UNAVAILABLE');
    return undefined;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', giveUp);
  }
};
