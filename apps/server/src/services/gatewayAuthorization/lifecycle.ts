import { appEnv } from '@/envs/app';
import { gatewayEnv } from '@/envs/gateway';
import { readBlobWithLimit } from '@/utils/readBlobWithLimit';

import type { GatewayLifecycleContext } from './types';
import { GatewayAuthorizationError, parseGatewayWire } from './wire';

export const closeGatewayRealtime = async (context: GatewayLifecycleContext) => {
  const targets = [
    {
      url: appEnv.AGENT_GATEWAY_INTERNAL_URL || appEnv.AGENT_GATEWAY_URL,
      token: appEnv.AGENT_GATEWAY_SERVICE_TOKEN,
    },
    { url: gatewayEnv.DEVICE_GATEWAY_URL, token: gatewayEnv.DEVICE_GATEWAY_SERVICE_TOKEN },
  ];
  await Promise.all(
    targets
      .filter((target) => target.url)
      .map(async ({ url, token }) => {
        if (!token || !context) throw new GatewayAuthorizationError('LIFECYCLE_STOP_FAILED', 503);
        const response = await fetch(
          `${url!.replace(/\/(?:tenant\/v1\/?)?$/, '')}/tenant/v1/api/control/tenant-suspend`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-LobeHub-Gateway-Tenancy': '1',
              'X-LobeHub-Tenant-Id': context.tenantId,
              'X-LobeHub-Tenant-Version': String(context.acceptedVersion),
            },
            body: JSON.stringify({ tenancyProtocol: 1, ...context }),
          },
        );
        if (
          !response.ok ||
          response.headers.get('X-LobeHub-Gateway-Tenancy') !== '1' ||
          response.headers.get('X-LobeHub-Tenant-Id') !== context.tenantId
        )
          throw new GatewayAuthorizationError('LIFECYCLE_STOP_FAILED', 503);
        const ack = parseGatewayWire<{
          tenantId: string;
          acceptedVersion: number;
        }>('suspendAck', JSON.parse(await (await readBlobWithLimit(response, 16_384)).text()));
        if (ack.tenantId !== context.tenantId || ack.acceptedVersion !== context.acceptedVersion)
          throw new GatewayAuthorizationError('LIFECYCLE_STOP_FAILED', 503);
      }),
  );
};
