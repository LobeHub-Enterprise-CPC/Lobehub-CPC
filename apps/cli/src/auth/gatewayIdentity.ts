import type { GatewayIdentityProvider } from '@lobechat/agent-gateway-client';
import { createGatewayIdentityMinter } from '@lobechat/agent-gateway-client';

interface GatewayCredential {
  serverUrl: string;
  token: string;
  tokenType: 'apiKey' | 'jwt' | 'serviceToken';
  userId: string;
}
interface IdentityOptions {
  audience?: 'urn:lobehub:gateway:agent' | 'urn:lobehub:gateway:device';
  initialTicket?: string;
  isCurrent?: () => boolean;
  operationId?: string;
  workspaceId?: string;
}

/** One provider owns exactly one credential source and one authorization. */
export function createGatewayIdentityProvider(
  auth: GatewayCredential,
  options: IdentityOptions = {},
): GatewayIdentityProvider {
  if (auth.tokenType === 'serviceToken') throw new Error('SOURCE_UNVERIFIABLE');
  // Capture the credential now: later changes to the caller's object must not re-bind it.
  const { serverUrl, token, userId } = auth;
  return createGatewayIdentityMinter({
    assertCurrent: (signal) => {
      signal.throwIfAborted();
      if (options.isCurrent?.() === false) throw new Error('GATEWAY_IDENTITY_CHANGED');
    },
    audience: options.audience,
    entryUrl: serverUrl,
    initialTicket: options.initialTicket,
    operationId: options.operationId,
    token,
    userId,
    workspaceId: options.workspaceId,
  });
}

/** Only transport/authority outages are safe for service-manager retries. */
export function isGatewayIdentityRetryable(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' ||
      error instanceof TypeError ||
      error.message === 'GATEWAY_AUTHORITY_UNAVAILABLE' ||
      error.message === 'fetch failed')
  );
}

export const workspaceAdminRequiredMessage =
  'The account signed in on this device must be a workspace administrator to accept sharing. Sign in with a workspace administrator account, then share this device again.';
