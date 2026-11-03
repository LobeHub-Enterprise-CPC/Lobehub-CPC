import type { GatewayConnectionErrorCode } from '@lobechat/electron-client-ipc';

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
