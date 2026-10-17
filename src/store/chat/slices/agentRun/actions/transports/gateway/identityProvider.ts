import {
  assertGatewayIdentityContinuity,
  gatewayIdentityHint,
} from '@lobechat/agent-gateway-client';
import type { GatewayIdentityProvider, GatewayIdentityResponse } from '@lobechat/types';

import { aiAgentService } from '@/services/aiAgent';

export const createBrowserGatewayIdentityProvider = (input: {
  token: string;
  topicId: string;
  operationId: string;
}): GatewayIdentityProvider => {
  let current: GatewayIdentityResponse | undefined;
  return async ({ signal }) => {
    signal.throwIfAborted();
    if (!current) {
      current = gatewayIdentityHint(input.token, 'urn:lobehub:gateway:agent', input.operationId);
      return current;
    }
    const { token } = await aiAgentService.refreshGatewayToken(
      input.topicId,
      current.authorizationId,
    );
    signal.throwIfAborted();
    const next = gatewayIdentityHint(token, 'urn:lobehub:gateway:agent', input.operationId);
    assertGatewayIdentityContinuity(current, next);
    current = next;
    return next;
  };
};
