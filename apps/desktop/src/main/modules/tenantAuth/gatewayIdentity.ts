import type { GatewayIdentityProvider } from '@lobechat/agent-gateway-client';
import { createGatewayIdentityMinter } from '@lobechat/agent-gateway-client';
import type { DataSyncConfig } from '@lobechat/electron-client-ipc';

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
  return createGatewayIdentityMinter({
    assertCurrent,
    entryUrl: originalTenant.entryUrl,
    fetch: fetchNoRedirect,
    initialTicket,
    readJson: readJsonLimited,
    tenantId: originalTenant.identity.tenantId,
    token,
    userId: originalTenant.identity.subject,
    workspaceId,
  });
}
