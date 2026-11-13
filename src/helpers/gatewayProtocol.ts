import { getServerConfigStoreState } from '@/store/serverConfig';

import tenancyProtocol from '../../contracts/gateway-tenancy/v2/protocol.json';

/**
 * `serverConfig` / `featureFlags`, read the same way the gateway transport does:
 * the global store first (the SPA and the desktop shell publish it on `window`
 * before the React store exists), then the module-level state.
 */
const getConfigState = () =>
  (typeof window !== 'undefined' ? window.global_serverConfigStore?.getState() : undefined) ??
  getServerConfigStoreState();

/** Contract capability and deployment protocol are the only mux gates. */
export const isGatewayMuxSupported = (): boolean =>
  !('mux' in tenancyProtocol.capabilities.disabled);

export const canUseGatewayProtocolV2 = (): boolean => {
  const state = getConfigState();

  return isGatewayMuxSupported() && state?.serverConfig?.agentGatewayProtocol === 2;
};

/** Relay remains independent of the stream protocol. */
export const isGatewayLlmRelaySupported = (): boolean =>
  !('llm-relay' in tenancyProtocol.capabilities.disabled);
