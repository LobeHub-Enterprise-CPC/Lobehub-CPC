import { redisService } from '@/server/services/redis';

import { discoveryAdmission, withDiscoveryDeadline } from './admission';
import { type DiscoveryCandidate, loadDiscoveryCandidates } from './candidates';
import { withLookupClient } from './connection';
import { DiscoveryError } from './errors';
import { discoveryIpBucket, emailFingerprint } from './protection';
import { queryTenantMembership } from './query';

interface AccountLookupInput {
  email: string;
  headers: Headers;
  signal: AbortSignal;
}

const admit = async (headers: Headers, email: string | undefined) => {
  const retryAfter = await redisService.tenantDiscovery.admit(
    'account',
    discoveryIpBucket(headers),
    email ? emailFingerprint(email) : undefined,
  );
  if (retryAfter !== null) throw new DiscoveryError('RATE_LIMITED', 429, retryAfter);
};

export const loadAccountOrganizations = async (
  signal: AbortSignal,
  email: string,
): Promise<DiscoveryCandidate[]> => {
  const candidates = await loadDiscoveryCandidates(signal);
  signal.throwIfAborted();
  return withLookupClient(signal, (client) => queryTenantMembership(client, candidates, email));
};

/**
 * The root-navigation lookup: optional work that must never compete with a user-initiated
 * discovery, so it takes a free admission slot or fails immediately.
 */
export const findAccountOrganizations = async ({
  email,
  headers,
  signal,
}: AccountLookupInput): Promise<DiscoveryCandidate[]> => {
  return withDiscoveryDeadline(signal, async (deadline) => {
    await admit(headers, email);
    return discoveryAdmission.tryRun(deadline, () => loadAccountOrganizations(deadline, email));
  });
};

export const loadAccountOrganization = async (
  signal: AbortSignal,
  email: string,
  id: string,
): Promise<DiscoveryCandidate> => {
  const candidates = await loadDiscoveryCandidates(signal, id);
  signal.throwIfAborted();
  const candidate = candidates.find((item) => item.id === id);
  if (!candidate) throw new DiscoveryError('TENANT_NOT_AVAILABLE', 404);
  const organizations = await withLookupClient(signal, (client) =>
    queryTenantMembership(client, [candidate], email),
  );
  signal.throwIfAborted();
  if (!organizations.some((item) => item.id === id))
    throw new DiscoveryError('TENANT_NOT_AVAILABLE', 404);
  return candidate;
};
