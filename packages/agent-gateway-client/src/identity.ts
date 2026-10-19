import { toRecord } from '@lobechat/utils/object';

import protocol from '../../../contracts/gateway-tenancy/v1/protocol.json';
import type { GatewayIdentityResponse, GatewayPrincipal } from '../../types/src/gateway';

/** Normalize provider failures to the frozen error catalog, never a parallel protocol enum. */
export const gatewayIdentityFailure = (
  error: unknown,
  transportError = false,
): { code: string; retryable: boolean } => {
  const detail = toRecord(error) ?? {};
  const message = error instanceof Error ? error.message : String(error);
  const entries = Object.entries(protocol.errors);
  const known = entries.find(
    ([code]) => detail.code === code || message === code || message.includes(code),
  );
  if (known) return { code: known[0], retryable: known[1].retryable };
  const status = Number(
    detail.status ??
      detail.statusCode ??
      toRecord(detail.response)?.status ??
      /unexpected server response:\s*(\d{3})/i.exec(message)?.[1],
  );
  if (
    [404, 405, 426, 501].includes(status) ||
    detail.code === 'ERR_INVALID_URL' ||
    /invalid url/i.test(message)
  )
    return { code: 'GATEWAY_TENANCY_UNSUPPORTED', retryable: false };
  if (
    status >= 500 ||
    status === 408 ||
    /^(?:ECONN|ENET|EHOST|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)/.test(String(detail.code)) ||
    /network|fetch failed|failed to fetch|connection refused|timed?\s*out/i.test(message) ||
    (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
  )
    return { code: 'GATEWAY_AUTHORITY_UNAVAILABLE', retryable: true };
  return {
    code:
      status === 401
        ? 'UNAUTHORIZED'
        : status === 403
          ? 'FORBIDDEN'
          : transportError
            ? 'GATEWAY_AUTHORITY_UNAVAILABLE'
            : 'SOURCE_UNVERIFIABLE',
    retryable: transportError && !Number.isFinite(status),
  };
};

export const assertGatewayIdentityContinuity = (
  previous: GatewayIdentityResponse | undefined,
  next: GatewayIdentityResponse,
  expectedPrincipal?: GatewayPrincipal,
) => {
  if (!next || next.tenancyProtocol !== 1) throw new Error('GATEWAY_TENANCY_UNSUPPORTED');
  if (previous && previous.tenantId !== next.tenantId) throw new Error('TENANT_MISMATCH');
  if (previous && previous.acceptedVersion !== next.acceptedVersion)
    throw new Error('TENANT_EXECUTION_VERSION_STALE');
  if (
    previous &&
    (previous.authorizationId !== next.authorizationId ||
      previous.userId !== next.userId ||
      previous.principal.kind !== next.principal.kind ||
      previous.principal.id !== next.principal.id)
  )
    throw new Error('SOURCE_UNVERIFIABLE');
  if (
    expectedPrincipal &&
    (expectedPrincipal.kind !== next.principal?.kind || expectedPrincipal.id !== next.principal?.id)
  )
    throw new Error('UNAUTHORIZED');
};

/** A policy/protocol close is terminal even if its preceding error frame was lost. */
export const gatewayCloseFailure = (code?: number, reason = ''): string | undefined => {
  if (![1002, 1003, 1007, 1008].includes(code ?? 0)) return;
  const entry = Object.entries(protocol.errors).find(([key]) => key === reason);
  return entry && !entry[1].retryable ? entry[0] : 'UNAUTHORIZED';
};
