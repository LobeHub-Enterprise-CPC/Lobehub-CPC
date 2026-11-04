import type {
  GatewayConnectionError,
  GatewayConnectionErrorCode,
  GatewayConnectionStatus,
} from '@lobechat/electron-client-ipc';

/** Why the last attempt ended, phrased with the next step (`electron` namespace). */
export const GATEWAY_ERROR_MESSAGE_KEYS = {
  auth_failed: 'gateway.error.authRejected',
  config_unavailable: 'gateway.error.configUnavailable',
  invalid_gateway_url: 'gateway.error.invalidAddress',
  not_signed_in: 'gateway.error.notSignedIn',
} as const satisfies Record<GatewayConnectionErrorCode, string>;

/**
 * Whether connecting again from this desktop can fix the failure. Signing in
 * or correcting the gateway address has to happen first.
 */
export const isGatewayFailureRetryable = (code: GatewayConnectionErrorCode | undefined) =>
  code !== 'not_signed_in' && code !== 'invalid_gateway_url';

/** Title bar and composer describe the same desktop connection, including in-flight attempts. */
export const getGatewayConnectionView = (
  status: GatewayConnectionStatus | undefined,
  error?: GatewayConnectionError,
  pending = false,
) => {
  const isConnecting =
    pending || status === 'connecting' || status === 'authenticating' || status === 'reconnecting';
  const isConnected = status === 'connected' && !pending;
  const isUnavailable = (!!status || pending) && !isConnected;
  return {
    canReconnect: isUnavailable && !isConnecting && isGatewayFailureRetryable(error?.code),
    isConnected,
    isConnecting,
    isUnavailable,
    messageKey:
      !isConnecting && error
        ? GATEWAY_ERROR_MESSAGE_KEYS[error.code]
        : isConnecting
          ? 'gateway.statusConnecting'
          : 'gateway.statusDisconnected',
  } as const;
};
