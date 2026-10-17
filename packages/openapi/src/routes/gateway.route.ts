import { isFullAccessApiKey } from '@lobechat/const/apiKeyScope';
import type { Context } from 'hono';
import { Hono } from 'hono';

import { mintGatewayTicket } from '@/server/services/gatewayAuthorization';
import type {
  GatewayAudience,
  GatewayAuthorizationSource,
} from '@/server/services/gatewayAuthorization/types';
import {
  GatewayAuthorizationError,
  parseGatewayWire,
} from '@/server/services/gatewayAuthorization/wire';

import { requireAuth } from '../middleware/auth';

export const GatewayRoutes = new Hono();
GatewayRoutes.post('/identity', requireAuth, async (c: Context) => {
  try {
    const input = parseGatewayWire<{
      audience: GatewayAudience;
      operationId?: string;
      workspaceId?: string;
      renewAuthorizationId?: string;
    }>('identityRequest', await c.req.json());
    const source = c.get('gatewaySource') as GatewayAuthorizationSource | undefined;
    if (!source) throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
    if (source.kind === 'apiKey' && input.workspaceId && input.workspaceId !== source.workspaceId)
      throw new GatewayAuthorizationError(
        input.renewAuthorizationId ? 'SOURCE_UNVERIFIABLE' : 'FORBIDDEN',
        input.renewAuthorizationId ? 401 : 403,
      );
    const workspaceId =
      input.workspaceId ?? (source.kind === 'apiKey' ? source.workspaceId : undefined);
    const capabilities =
      input.audience === 'urn:lobehub:gateway:device'
        ? (['device:connect', 'device:respond'] as const)
        : source.kind === 'apiKey' && !isFullAccessApiKey(c.get('apiKeyScopes') ?? null)
          ? (['agent:observe'] as const)
          : (['agent:observe', 'agent:respond', 'agent:execute'] as const);
    const identity = await mintGatewayTicket({
      source,
      audience: input.audience,
      operationId: input.operationId,
      principal:
        workspaceId && input.audience === 'urn:lobehub:gateway:device'
          ? { kind: 'workspace', id: workspaceId }
          : { kind: 'user', id: source.subject },
      capabilities: [...capabilities],
      renewAuthorizationId: input.renewAuthorizationId,
    });
    c.header('Cache-Control', 'private, no-store');
    c.header('X-LobeHub-Gateway-Tenancy', '1');
    c.header('X-LobeHub-Tenant-Id', identity.tenantId);
    return c.json(identity);
  } catch (error) {
    const known = error instanceof GatewayAuthorizationError;
    if (!known)
      console.error(
        'Gateway identity exchange failed',
        error instanceof Error ? error.name : 'UnknownError',
      );
    return c.json(
      {
        tenancyProtocol: 1,
        error: {
          code: known ? error.code : 'GATEWAY_AUTHORITY_UNAVAILABLE',
          message: known ? error.code : 'GATEWAY_AUTHORITY_UNAVAILABLE',
        },
      },
      (known ? error.status : 503) as 400 | 401 | 403 | 404 | 409 | 501 | 503,
    );
  }
});
