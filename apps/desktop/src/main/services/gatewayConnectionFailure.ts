import { gatewayIdentityFailure } from '@lobechat/agent-gateway-client';
import type { DeviceGatewayResolutionWithDefault } from '@lobechat/device-gateway-client/endpoint';
import type { GatewayConnectionError } from '@lobechat/electron-client-ipc';

/** Keep transport failures, login prerequisites and credential refusals distinct. */
export const describeIdentityFailure = (error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    error: {
      code: ['GATEWAY_LOGIN_CONFIRMATION_REQUIRED', 'GATEWAY_IDENTITY_CHANGED'].includes(detail)
        ? 'not_signed_in'
        : 'auth_failed',
      detail,
    } satisfies GatewayConnectionError,
    retryable: gatewayIdentityFailure(error).retryable,
  };
};

/** Discovery retains its transport reason; malformed config and 4xx require intervention. */
export const isDiscoveryFailureRetryable = (detail = '') => {
  const status = /^HTTP (\d{3})$/.exec(detail)?.[1];
  return gatewayIdentityFailure(status ? { status: Number(status) } : new Error(detail)).retryable;
};

export const describeResolutionFailure = (
  resolution: Extract<DeviceGatewayResolutionWithDefault, { ok: false }>,
): GatewayConnectionError => {
  switch (resolution.reason) {
    case 'discovery_failed': {
      return { code: 'config_unavailable', detail: resolution.detail };
    }
    case 'invalid_advertised_url':
    case 'invalid_manual':
    case 'invalid_override': {
      return { code: 'invalid_gateway_url', detail: resolution.detail };
    }
  }
};
