import { GatewayMuxClient } from '@lobechat/agent-gateway-client';

import { aiAgentService } from '@/services/aiAgent';
import { getLlmRelayClientId } from '@/services/llmRelay/clientId';

export interface GatewayMuxIdentity {
  /** Gateway URL base (e.g. https://agent-gateway.lobehub.com). */
  gatewayUrl: string;
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

const identityKey = ({ gatewayUrl }: GatewayMuxIdentity): string => gatewayUrl;

/**
 * `getToken` is invoked before EVERY dial (initial connect, backoff retry,
 * 4401 refresh), so the mux never needs the v1 `auth_expired` → `updateToken`
 * round trip.
 */
const getToken = async (): Promise<string> => {
  const { token } = await aiAgentService.issueGatewayUserToken();
  return token;
};

/**
 * One `GatewayMuxClient` per gateway URL for
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
    mux = new GatewayMuxClient({
      // The id this tab declares as its LLM executor, so the hub can hand
      // `llm_execute` to the tab that started the run.
      clientId: getLlmRelayClientId(),
      gatewayUrl: identity.gatewayUrl,
      getToken,
      keepAlive: true,
    });
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
