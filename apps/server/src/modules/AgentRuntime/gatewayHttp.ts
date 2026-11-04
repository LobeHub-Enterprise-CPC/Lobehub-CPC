import { isLlmRelayChannelId } from '@lobechat/agent-gateway-client';
import { requireTenantScope } from '@lobechat/database/tenant';
import { Agent } from 'undici';
import urlJoin from 'url-join';

import { loadGatewayOperation } from '@/server/services/gatewayAuthorization/operationAuthority';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';
import { readBlobWithLimit } from '@/utils/readBlobWithLimit';

/**
 * In-cluster connects take milliseconds, while a gateway Service with no ready
 * Pod (a restart) never answers. Failing the connect fast lets callers tell a
 * request that never connected from one that may have been delivered.
 */
const gatewayDispatcher = new Agent({ connect: { timeout: 1000 } });
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True when the request never connected, so the gateway cannot have received it. */
export const isGatewayUnreachable = (error: unknown): boolean => {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === 'string' && UNREACHABLE_CODES.has(code);
};

/** Each operation's persisted intent supplies the version; retries never stamp the current scope. */
export const gatewayOperationPost = async (
  url: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => {
  if (typeof body.operationId !== 'string')
    throw new GatewayAuthorizationError('INVALID_GATEWAY_MESSAGE', 400);
  if (path.startsWith('/api/operations/llm-') || isLlmRelayChannelId(body.operationId))
    throw new GatewayAuthorizationError('LLM_RELAY_UNSUPPORTED', 501);
  const scope = requireTenantScope();
  const row = await loadGatewayOperation(body.operationId);
  const version = row.metadata?.sourceAcceptedVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_REQUIRED', 400);
  if (body.userId && body.userId !== row.userId)
    throw new GatewayAuthorizationError('OPERATION_OWNER_CONFLICT', 409);
  const base = url.replace(/\/tenant\/v1\/?$/, '');
  const response = await fetch(urlJoin(base, 'tenant/v1', path), {
    dispatcher: gatewayDispatcher,
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-LobeHub-Gateway-Tenancy': '1',
      'X-LobeHub-Tenant-Id': scope.tenantId,
      'X-LobeHub-Tenant-Version': String(version),
    },
    body: JSON.stringify({
      ...body,
      userId: row.userId,
      tenantId: scope.tenantId,
      sourceAcceptedVersion: version,
    }),
  } as RequestInit);
  if (response.status === 404 || response.status === 426)
    throw new GatewayAuthorizationError('GATEWAY_TENANCY_UNSUPPORTED', 426);
  if (
    response.ok &&
    (response.headers.get('X-LobeHub-Gateway-Tenancy') !== '1' ||
      response.headers.get('X-LobeHub-Tenant-Id') !== scope.tenantId)
  )
    throw new GatewayAuthorizationError('TENANT_MISMATCH', 403);
  const text = await (await readBlobWithLimit(response, 1024 * 1024)).text();
  return { body: text, ok: response.ok, status: response.status };
};
