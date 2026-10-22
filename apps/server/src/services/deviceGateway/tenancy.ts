import type { GatewayHttpClientOptions } from '@lobechat/device-gateway-client';

import {
  createGatewayAttempt,
  settleDeviceGatewayDispatch,
} from '@/server/services/gatewayAuthorization/attempts';
import {
  currentGatewaySource,
  gatewayExecutionContext,
  operationGatewaySource,
} from '@/server/services/gatewayAuthorization/context';
import {
  loadGatewayOperation,
  operationExecutionContext,
} from '@/server/services/gatewayAuthorization/operationAuthority';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';

import { gatewayDeviceTarget } from './access';

export const deviceGatewayTenancy = (): Pick<
  GatewayHttpClientOptions,
  'tenantId' | 'execution' | 'prepareDispatch' | 'settleDispatch'
> => {
  const execution = gatewayExecutionContext();
  return {
    tenantId: execution.tenantId,
    execution,
    settleDispatch: settleDeviceGatewayDispatch,
    prepareDispatch: async (input) => {
      const original = input.operationId
        ? await operationExecutionContext(input.operationId)
        : execution;
      const actor = input.operationId
        ? (await loadGatewayOperation(input.operationId)).userId
        : currentGatewaySource()?.subject;
      const source =
        input.operationId && actor
          ? operationGatewaySource(actor, input.operationId)
          : currentGatewaySource();
      if (!source) throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
      const resourceId = await gatewayDeviceTarget(
        source.subject,
        input.targetPrincipal,
        input.resourceId || undefined,
      );
      const intent = await createGatewayAttempt({
        ...original,
        source,
        ...input,
        resourceId,
        attemptExpiresAt: Date.now() + 300_000,
      });
      return { ...original, intent };
    },
  };
};
