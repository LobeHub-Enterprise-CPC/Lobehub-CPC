import type {
  GatewayIdentityProvider,
  GatewayIdentityResponse,
} from '@lobechat/agent-gateway-client';
import { gatewayIdentityHint } from '@lobechat/agent-gateway-client';
import type { DataSyncConfig } from '@lobechat/electron-client-ipc';
import { buildRemoteUrl } from '@lobechat/utils/remoteUrl';

import protocol from '../../../../../../contracts/gateway-tenancy/v1/protocol.json';
import { fetchNoRedirect, readJsonLimited } from './safeFetch';

interface IdentityHost {
  getAccessToken: () => Promise<string | null>;
  getConfig: () => Promise<DataSyncConfig>;
  isPaused: () => boolean;
}

/** Capture the committed login, never the pending confirmation or a later login with the same sub. */
export async function createDesktopGatewayIdentityProvider(
  host: IdentityHost,
  workspaceId?: string,
  initialTicket?: string,
): Promise<GatewayIdentityProvider> {
  const config = await host.getConfig();
  const tenant = config.cloudTenant;
  const token = await host.getAccessToken();
  if (!config.active || !tenant?.generation || !token || host.isPaused())
    throw new Error('GATEWAY_LOGIN_CONFIRMATION_REQUIRED');
  const originalTenant = { ...tenant, identity: { ...tenant.identity } };
  let identity: GatewayIdentityResponse | undefined;
  const enrollment = initialTicket
    ? gatewayIdentityHint(initialTicket, 'urn:lobehub:gateway:device')
    : undefined;
  const assertCurrent = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = await host.getConfig();
    signal.throwIfAborted();
    if (
      !current.active ||
      host.isPaused() ||
      current.cloudTenant?.generation !== originalTenant.generation ||
      current.cloudTenant?.entryUrl !== originalTenant.entryUrl ||
      current.cloudTenant?.identity.tenantId !== originalTenant.identity.tenantId ||
      current.cloudTenant?.identity.subject !== originalTenant.identity.subject
    )
      throw new Error('GATEWAY_IDENTITY_CHANGED');
  };
  const validate = (next: GatewayIdentityResponse) => {
    const hint = gatewayIdentityHint(next.gatewayTicket, 'urn:lobehub:gateway:device');
    const principal = workspaceId
      ? { kind: 'workspace', id: workspaceId }
      : { kind: 'user', id: originalTenant.identity.subject };
    if (
      next.tenancyProtocol !== 1 ||
      (enrollment &&
        (next.tenantId !== enrollment.tenantId ||
          next.principal?.id !== enrollment.principal.id ||
          next.principal?.kind !== enrollment.principal.kind)) ||
      next.userId !== originalTenant.identity.subject ||
      next.tenantId !== originalTenant.identity.tenantId ||
      next.tenantId !== hint.tenantId ||
      next.userId !== hint.userId ||
      next.ticketExpiresAt !== hint.ticketExpiresAt ||
      !Number.isSafeInteger(next.authRecordExpiresAt) ||
      !Array.isArray(next.capabilities) ||
      JSON.stringify([...next.capabilities].sort()) !==
        JSON.stringify([...hint.capabilities].sort()) ||
      next.acceptedVersion !== hint.acceptedVersion ||
      next.authorizationId !== hint.authorizationId ||
      next.principal?.kind !== principal.kind ||
      next.principal?.id !== principal.id ||
      hint.principal.kind !== principal.kind ||
      hint.principal.id !== principal.id ||
      Math.min(next.ticketExpiresAt, next.authRecordExpiresAt) <= Date.now() ||
      (identity &&
        (next.authorizationId !== identity.authorizationId ||
          next.acceptedVersion !== identity.acceptedVersion))
    )
      throw new Error('GATEWAY_IDENTITY_CHANGED');
    identity = next;
    return next;
  };
  return async ({ signal }) => {
    await assertCurrent(signal);
    const response = await fetchNoRedirect(
      buildRemoteUrl('/api/v1/gateway/identity', originalTenant.entryUrl).toString(),
      {
        body: JSON.stringify({
          tenancyProtocol: 1,
          audience: 'urn:lobehub:gateway:device',
          ...(workspaceId ? { workspaceId } : {}),
          ...(identity ? { renewAuthorizationId: identity.authorizationId } : {}),
        }),
        headers: { 'Content-Type': 'application/json', 'Oidc-Auth': token },
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
    );
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
        const body = await readJsonLimited<{ error?: { code?: string } }>(response, 64 * 1024);
        if (body?.error?.code && Object.hasOwn(protocol.errors, body.error.code))
          code = body.error.code;
      } else await response.body?.cancel();
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    const next = await readJsonLimited<GatewayIdentityResponse>(response, 64 * 1024);
    await assertCurrent(signal);
    if (
      response.headers.get('X-LobeHub-Gateway-Tenancy') !== '1' ||
      response.headers.get('X-LobeHub-Tenant-Id') !== next.tenantId
    )
      throw new Error('GATEWAY_TENANCY_UNSUPPORTED');
    return validate(next);
  };
}
