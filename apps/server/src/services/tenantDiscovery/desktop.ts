import { z } from 'zod';

import { redisService } from '@/server/services/redis';
import type { DesktopSelectionSnapshot } from '@/server/services/redis/tenantDiscovery';

import { discoveryAdmission, withDiscoveryDeadline } from './admission';
import { loadDiscoveryCandidates } from './candidates';
import { withLookupClient } from './connection';
import type { DesktopFlow } from './desktopFlow';
import { desktopFlowSchema } from './desktopFlow';
import { DiscoveryError } from './errors';
import { desktopStateFingerprint, discoveryIpBucket } from './protection';
import { verifyCandidateObjects } from './query';

const snapshotSchema = z
  .object({
    tenantId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.:-]+$/),
    entry: z.string().url().max(2048),
    name: z.string().min(1).max(4096),
    endpointVersion: z.number().int().positive(),
    codeChallenge: desktopFlowSchema.shape.codeChallenge,
    expiresAt: z.number().finite().positive(),
  })
  .strict();

const requireSnapshot = (raw: unknown): DesktopSelectionSnapshot => {
  const result = snapshotSchema.safeParse(raw);
  if (!result.success || result.data.expiresAt <= Date.now())
    throw new DiscoveryError('HANDOFF_EXISTS', 409);
  const url = new URL(result.data.entry);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    result.data.entry.endsWith('/') ||
    (url.protocol !== 'https:' &&
      !(
        process.env.NODE_ENV !== 'production' &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      ))
  )
    throw new DiscoveryError('HANDOFF_EXISTS', 409);
  return result.data;
};

/** Every replay is constructed only from the immutable original snapshot. */
export const buildDesktopAuthorizeUrl = (snapshot: DesktopSelectionSnapshot, state: string) => {
  const url = new URL(`${snapshot.entry}/oidc/auth`);
  url.search = new URLSearchParams({
    client_id: 'lobehub-desktop',
    code_challenge: snapshot.codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
    redirect_uri: `${snapshot.entry}/oidc/callback/desktop`,
    resource: 'urn:lobehub:chat',
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state,
  }).toString();
  return url.href;
};
interface DesktopSelectionInput {
  flow: DesktopFlow;
  headers: Headers;
  signal: AbortSignal;
  tenantId: string;
}
const replaySelection = (raw: unknown, tenantId: string, flow: DesktopFlow) => {
  const snapshot = requireSnapshot(raw);
  if (snapshot.tenantId !== tenantId || snapshot.codeChallenge !== flow.codeChallenge)
    throw new DiscoveryError('HANDOFF_EXISTS', 409);
  return { url: buildDesktopAuthorizeUrl(snapshot, flow.state) };
};

/** Shared by the protected GET launch and select POST; admission happens exactly once. */
export const selectDesktopTenant = ({
  headers,
  flow,
  tenantId,
  signal,
}: DesktopSelectionInput): Promise<{ url: string }> =>
  withDiscoveryDeadline(signal, async (activeSignal) => {
    if (!desktopFlowSchema.safeParse(flow).success || !/^[\w.:-]{1,128}$/.test(tenantId))
      throw new DiscoveryError('INVALID_REQUEST', 400);
    const limited = await redisService.tenantDiscovery.admit('select', discoveryIpBucket(headers));
    if (limited !== null) throw new DiscoveryError('RATE_LIMITED', 429, limited);
    activeSignal.throwIfAborted();
    const key = desktopStateFingerprint(flow.state);
    const existing = await redisService.tenantDiscovery.getDesktopSelection(key);
    if (existing !== null) return replaySelection(existing, tenantId, flow);
    return discoveryAdmission.run(activeSignal, async () => {
      const candidates = await loadDiscoveryCandidates(activeSignal, tenantId);
      const candidate = candidates.find((c) => c.id === tenantId);
      if (!candidate) throw new DiscoveryError('TENANT_NOT_AVAILABLE', 404);
      await withLookupClient(activeSignal, (client) => verifyCandidateObjects(client, [candidate]));
      activeSignal.throwIfAborted();
      const snapshot: DesktopSelectionSnapshot = {
        tenantId: candidate.id,
        entry: candidate.activeUrl,
        name: candidate.name,
        endpointVersion: candidate.endpointVersion,
        codeChallenge: flow.codeChallenge,
        expiresAt: Date.now() + 600_000,
      };
      requireSnapshot(snapshot);
      // SET NX never refreshes TTL. A racing winner is returned without rebuilding its entry.
      const stored = await redisService.tenantDiscovery.putDesktopSelection(key, snapshot);
      if (stored === null) throw new DiscoveryError('HANDOFF_EXISTS', 409);
      activeSignal.throwIfAborted();
      return replaySelection(stored, tenantId, flow);
    });
  });

export const readDesktopHandoff = async ({
  headers,
  flow,
  signal,
}: Omit<DesktopSelectionInput, 'tenantId'>) => {
  if (!desktopFlowSchema.safeParse(flow).success) throw new DiscoveryError('INVALID_REQUEST', 400);
  const limited = await redisService.tenantDiscovery.admit('handoff', discoveryIpBucket(headers));
  if (limited !== null) throw new DiscoveryError('RATE_LIMITED', 429, limited);
  signal.throwIfAborted();
  const raw = await redisService.tenantDiscovery.readDesktopHandoff(
    desktopStateFingerprint(flow.state),
    flow.codeChallenge,
  );
  if (raw === null) throw new DiscoveryError('HANDOFF_NOT_FOUND', 404);
  let snapshot;
  try {
    snapshot = requireSnapshot(raw);
  } catch {
    throw new DiscoveryError('HANDOFF_NOT_FOUND', 404);
  }
  signal.throwIfAborted();
  return {
    tenantId: snapshot.tenantId,
    entry: snapshot.entry,
    name: snapshot.name,
    endpointVersion: snapshot.endpointVersion,
  };
};
