import { createTenancyMuxTransport, GatewayMuxClient } from '@lobechat/agent-gateway-client';
import { getTenantScopeId } from '@lobechat/business-tenant/client';

import { aiAgentService } from '@/services/aiAgent';
import { getLlmRelayClientId } from '@/services/llmRelay/clientId';
import { getUserStoreState } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

export interface GatewayMuxIdentity {
  /** Gateway URL base (e.g. https://agent-gateway.lobehub.com). */
  gatewayUrl: string;
  tenantId?: string;
  userId?: string;
}

const registry = new Map<string, GatewayMuxClient>();

/**
 * Identities whose mux gave up on protocol v2 (`/v2/ws` missing, the token
 * endpoint absent, the hub refusing the token). Page-scoped on purpose: a
 * reload retries v2, so a transient outage does not pin the tab to v1 for the
 * rest of the session, while a deployment that genuinely has no v2 only pays
 * the dial budget once per page.
 */
const unavailableIdentities = new Set<string>();

export const resolveGatewayMuxIdentity = (identity: GatewayMuxIdentity) => ({
  gatewayUrl: identity.gatewayUrl,
  tenantId: identity.tenantId ?? getTenantScopeId(),
  userId: identity.userId ?? userProfileSelectors.userId(getUserStoreState()),
});
const identityKey = (identity: GatewayMuxIdentity): string => {
  const { gatewayUrl, tenantId, userId } = resolveGatewayMuxIdentity(identity);
  return JSON.stringify([gatewayUrl, tenantId, userId]);
};

/**
 * One `GatewayMuxClient` per gateway URL, tenant and user for
 * the lifetime of the page. Every operation on the same identity multiplexes
 * over that single socket (protocol v2). The socket is dialed on app entry by
 * `warmupGatewayMux` (or lazily on the first `subscribe` if that never ran)
 * and is kept up across runs — `keepAlive` so a drop is redialed even while
 * nothing is subscribed.
 */
export const getGatewayMux = (identity: GatewayMuxIdentity): GatewayMuxClient => {
  const key = identityKey(identity);
  let mux = registry.get(key);
  if (!mux) {
    const resolved = resolveGatewayMuxIdentity(identity);
    const transport = createTenancyMuxTransport({
      clientId: getLlmRelayClientId(),
      gatewayUrl: resolved.gatewayUrl,
      userId: resolved.userId,
      // Browser scope is a slug, not a signed tenant ID. The ticket pins the
      // tenant; registry partitioning still follows the document/desktop scope.
      issueToken: (input) => {
        const active = resolveGatewayMuxIdentity({ gatewayUrl: identity.gatewayUrl });
        if (active.tenantId !== resolved.tenantId || active.userId !== resolved.userId)
          throw new Error('SOURCE_UNVERIFIABLE');
        return aiAgentService.issueGatewayUserToken(input);
      },
    });
    mux = new GatewayMuxClient({
      ...transport,
      // Stable per-tab connection identity.
      clientId: getLlmRelayClientId(),
      gatewayUrl: identity.gatewayUrl,
      keepAlive: true,
    });
    transport.bindMux(mux);
    mux.on('unavailable', () => markGatewayMuxUnavailable(resolved));
    registry.set(key, mux);
  }
  return mux;
};

/**
 * Whether protocol v2 has already failed for this identity on this page, in
 * which case the caller must use the v1 per-operation socket instead.
 */
export const isGatewayMuxUnavailable = (identity: GatewayMuxIdentity): boolean =>
  unavailableIdentities.has(identityKey(identity));

/**
 * Record that protocol v2 does not work for this identity, and forget the dead
 * mux so a later `getGatewayMux` never hands out a client that will not dial
 * again. Called by the transport when the mux reports itself `unavailable`.
 */
export const markGatewayMuxUnavailable = (identity: GatewayMuxIdentity): void => {
  const key = identityKey(identity);
  unavailableIdentities.add(key);
  registry.delete(key);
};

/**
 * Tear down every mux (they hold window listeners and the lifecycle → store
 * feed) and forget them. Called when the user-data context resets
 * (`stores.reset()`, e.g. the desktop app switching or disconnecting its
 * remote server) so a socket authenticated for the previous identity never
 * outlives it or keeps writing into the reset chat store; also a test seam.
 */
export const resetGatewayMuxRegistry = (): void => {
  for (const mux of registry.values()) mux.disconnect();
  registry.clear();
  // A new user-data context is a new deployment as far as this page knows
  // (the desktop app switching remote servers), so the v2 verdict starts over.
  unavailableIdentities.clear();
};
