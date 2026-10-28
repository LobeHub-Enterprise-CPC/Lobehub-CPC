import { isLlmRelayChannelId } from '@lobechat/agent-gateway-client';
import { requireTenantScope } from '@lobechat/database/tenant';
import urlJoin from 'url-join';

import { loadGatewayOperation } from '@/server/services/gatewayAuthorization/operationAuthority';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';
import { readBlobWithLimit } from '@/utils/readBlobWithLimit';

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
  });
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
