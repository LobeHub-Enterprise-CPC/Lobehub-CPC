import type {
  GatewayIdentityProvider,
  GatewayIdentityResponse,
} from '@lobechat/agent-gateway-client';
import { gatewayIdentityHint } from '@lobechat/agent-gateway-client';
import { buildRemoteUrl } from '@lobechat/utils/remoteUrl';

import protocol from '../../../../contracts/gateway-tenancy/v1/protocol.json';

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
  const audience = options.audience ?? 'urn:lobehub:gateway:device';
  const base = new URL(auth.serverUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  )
    throw new Error('GATEWAY_IDENTITY_ENTRY_INVALID');
  if (auth.tokenType === 'serviceToken') throw new Error('SOURCE_UNVERIFIABLE');
  const credential = { ...auth };
  let original: GatewayIdentityResponse | undefined;
  const enrollment = options.initialTicket
    ? gatewayIdentityHint(options.initialTicket, audience, options.operationId)
    : undefined;
  let inFlight: Promise<GatewayIdentityResponse> | undefined;
  const assertCurrent = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (options.isCurrent?.() === false) throw new Error('GATEWAY_IDENTITY_CHANGED');
  };
  const validate = (identity: GatewayIdentityResponse) => {
    const hint = gatewayIdentityHint(identity.gatewayTicket, audience, options.operationId);
    const principal =
      options.workspaceId && audience.endsWith(':device')
        ? { kind: 'workspace', id: options.workspaceId }
        : { kind: 'user', id: credential.userId };
    if (
      identity.tenancyProtocol !== 1 ||
      identity.userId !== credential.userId ||
      (enrollment &&
        (identity.tenantId !== enrollment.tenantId ||
          identity.principal?.id !== enrollment.principal.id ||
          identity.principal?.kind !== enrollment.principal.kind)) ||
      identity.tenantId !== hint.tenantId ||
      identity.userId !== hint.userId ||
      identity.ticketExpiresAt !== hint.ticketExpiresAt ||
      !Number.isSafeInteger(identity.authRecordExpiresAt) ||
      !Array.isArray(identity.capabilities) ||
      JSON.stringify([...identity.capabilities].sort()) !==
        JSON.stringify([...hint.capabilities].sort()) ||
      identity.authorizationId !== hint.authorizationId ||
      identity.acceptedVersion !== hint.acceptedVersion ||
      identity.principal?.id !== principal.id ||
      identity.principal?.kind !== principal.kind ||
      hint.principal.id !== principal.id ||
      hint.principal.kind !== principal.kind ||
      Math.min(identity.ticketExpiresAt, identity.authRecordExpiresAt) <= Date.now() ||
      (original &&
        (identity.authorizationId !== original.authorizationId ||
          identity.tenantId !== original.tenantId ||
          identity.acceptedVersion !== original.acceptedVersion))
    )
      throw new Error('GATEWAY_IDENTITY_CHANGED');
    original = identity;
    return identity;
  };
  const mint = async (signal: AbortSignal) => {
    assertCurrent(signal);
    const response = await fetch(buildRemoteUrl('/api/v1/gateway/identity', credential.serverUrl), {
      body: JSON.stringify({
        tenancyProtocol: 1,
        audience,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(original ? { renewAuthorizationId: original.authorizationId } : {}),
      }),
      headers: {
        'Content-Type': 'application/json',
        [credential.tokenType === 'apiKey' ? 'X-API-Key' : 'Oidc-Auth']: credential.token,
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      let code = [404, 405, 426, 501].includes(response.status)
        ? 'GATEWAY_TENANCY_UNSUPPORTED'
        : response.status >= 500 || [408, 425, 429].includes(response.status)
          ? 'GATEWAY_AUTHORITY_UNAVAILABLE'
          : 'SOURCE_UNVERIFIABLE';
      if (
        [401, 403, 409].includes(response.status) &&
        response.headers.get('Content-Type')?.includes('application/json')
      ) {
        const body = await readIdentityJson<{ error?: { code?: string } }>(response, 64 * 1024);
        if (body?.error?.code && Object.hasOwn(protocol.errors, body.error.code))
          code = body.error.code;
      } else await response.body?.cancel();
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    const identity = await readIdentityJson<GatewayIdentityResponse>(response, 64 * 1024);
    assertCurrent(signal);
    if (
      response.headers.get('X-LobeHub-Gateway-Tenancy') !== '1' ||
      response.headers.get('X-LobeHub-Tenant-Id') !== identity.tenantId
    )
      throw new Error('GATEWAY_TENANCY_UNSUPPORTED');
    return validate(identity);
  };
  return async ({ signal }) => {
    // Prevent concurrent renewals from overwriting this provider's original binding.
    assertCurrent(signal);
    if (inFlight) await inFlight;
    assertCurrent(signal);
    const request = mint(signal);
    inFlight = request;
    try {
      return await request;
    } finally {
      if (inFlight === request) inFlight = undefined;
    }
  };
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

async function readIdentityJson<T>(response: Response, maxBytes: number): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_GATEWAY_MESSAGE');
  let length = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error('INVALID_GATEWAY_MESSAGE');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (error) {
    throw new Error('INVALID_GATEWAY_MESSAGE', { cause: error });
  }
}
