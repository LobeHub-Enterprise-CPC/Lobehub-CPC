import { buildRemoteUrl } from '@lobechat/utils/remoteUrl';

import protocol from '../../../contracts/gateway-tenancy/v1/protocol.json';
import type { GatewayIdentityProvider, GatewayIdentityResponse } from '../../types/src/gateway';
import { gatewayEnrollmentHint, gatewayIdentityHint, gatewayTicketClaims } from './tenancy';

const IDENTITY_BODY_LIMIT = 64 * 1024;
const IDENTITY_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

type IdentityAudience = 'urn:lobehub:gateway:agent' | 'urn:lobehub:gateway:device';

export interface GatewayIdentityMinterOptions {
  /** Checked before the request and again before the response is trusted; throws to abandon. */
  assertCurrent: (signal: AbortSignal) => Promise<void> | undefined;
  audience?: IdentityAudience;
  /** Tenant address the identity is minted at (`https://host[/orgs/slug]`). */
  entryUrl: string;
  /** Transport for the identity request; never follow redirects. Defaults to global `fetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  initialTicket?: string;
  operationId?: string;
  /** Bounded JSON reader of the host; defaults to a streaming reader over `response.body`. */
  readJson?: <T>(response: Response, maxBytes: number) => Promise<T>;
  /** Tenant the login is pinned to; omitted when the first response pins it. */
  tenantId?: string;
  /** The one credential this provider will ever send. */
  token: string;
  /** Account subject the identity must belong to. */
  userId: string;
  workspaceId?: string;
}

export const assertGatewayEntryUrl = (entryUrl: string): void => {
  const base = new URL(entryUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && LOOPBACK_HOSTS.includes(base.hostname)))
  )
    throw new Error('GATEWAY_IDENTITY_ENTRY_INVALID');
};

const readJsonLimited = async <T>(response: Response, maxBytes: number): Promise<T> => {
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
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch (error) {
    throw new Error('INVALID_GATEWAY_MESSAGE', { cause: error });
  }
};

/**
 * One provider owns exactly one credential, one tenant address and one
 * authorization: mint the gateway identity with it, renew only that same
 * authorization, and refuse any response that is not the same account,
 * tenant, principal and accepted version.
 */
export function createGatewayIdentityMinter(
  options: GatewayIdentityMinterOptions,
): GatewayIdentityProvider {
  const audience = options.audience ?? 'urn:lobehub:gateway:device';
  assertGatewayEntryUrl(options.entryUrl);
  const { assertCurrent, entryUrl, token, userId } = options;
  const send = options.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'error' }));
  const readJson = options.readJson ?? readJsonLimited;
  let original: GatewayIdentityResponse | undefined;
  const enrollment = options.initialTicket
    ? gatewayEnrollmentHint(options.initialTicket, audience)
    : undefined;
  let inFlight: Promise<GatewayIdentityResponse> | undefined;

  const validate = (
    identity: GatewayIdentityResponse,
    asked: { connectionId?: string; deviceId?: string },
  ) => {
    const hint = gatewayIdentityHint(identity.gatewayTicket, audience, options.operationId);
    // Work signs the device and connection it was asked for; a ticket naming
    // anything else is not the one requested.
    const signed = gatewayTicketClaims(identity.gatewayTicket);
    const principal =
      options.workspaceId && audience.endsWith(':device')
        ? { kind: 'workspace', id: options.workspaceId }
        : { kind: 'user', id: userId };
    if (
      identity.tenancyProtocol !== 1 ||
      signed.deviceId !== asked.deviceId ||
      signed.connectionId !== asked.connectionId ||
      identity.userId !== userId ||
      (options.tenantId !== undefined && identity.tenantId !== options.tenantId) ||
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

  const mint = async (signal: AbortSignal, asked: { connectionId?: string; deviceId?: string }) => {
    // A synchronous host check must not defer the request by a microtask.
    const current = assertCurrent(signal);
    if (current) await current;
    const response = await send(buildRemoteUrl('/api/v1/gateway/identity', entryUrl).toString(), {
      body: JSON.stringify({
        tenancyProtocol: 1,
        audience,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(asked.deviceId ? { deviceId: asked.deviceId } : {}),
        ...(asked.connectionId ? { connectionId: asked.connectionId } : {}),
        ...(original ? { renewAuthorizationId: original.authorizationId } : {}),
      }),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(IDENTITY_TIMEOUT_MS)]),
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
        const body = await readJson<{ error?: { code?: string } }>(response, IDENTITY_BODY_LIMIT);
        if (body?.error?.code && Object.hasOwn(protocol.errors, body.error.code))
          code = body.error.code;
      } else await response.body?.cancel();
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    const identity = await readJson<GatewayIdentityResponse>(response, IDENTITY_BODY_LIMIT);
    await assertCurrent(signal);
    if (
      response.headers.get('X-LobeHub-Gateway-Tenancy') !== '1' ||
      response.headers.get('X-LobeHub-Tenant-Id') !== identity.tenantId
    )
      throw new Error('GATEWAY_TENANCY_UNSUPPORTED');
    return validate(identity, asked);
  };

  return async ({ connectionId, deviceId, signal }) => {
    // A device ticket names the device and the socket; an agent ticket names no
    // device and a socket only when the client has one to offer.
    const device = audience.endsWith(':device');
    if (device && (!deviceId || !connectionId)) throw new Error('INVALID_GATEWAY_MESSAGE');
    const asked = { connectionId, ...(device ? { deviceId } : {}) };
    // Concurrent renewals must not overwrite this provider's original binding.
    const before = assertCurrent(signal);
    if (before) await before;
    if (inFlight) {
      await inFlight.catch(() => undefined);
      await assertCurrent(signal);
    }
    const request = mint(signal, asked);
    inFlight = request;
    try {
      return await request;
    } finally {
      if (inFlight === request) inFlight = undefined;
    }
  };
}
