import { isOfficialCloudServer, OFFICIAL_URL } from '@lobechat/const';
import { buildRemoteUrl, normalizeRemoteBaseUrl } from '@lobechat/utils/remoteUrl';

import { type ElectronState } from '../initialState';

const isSyncActive = (s: ElectronState) => s.dataSyncConfig.active ?? false;

const storageMode = (s: ElectronState) => s.dataSyncConfig.storageMode;

/** Consume main's usable session: a committed binding or restored legacy selfHost. */
const serverConfigScope = (s: ElectronState): string | null => {
  const { cloudTenant, active, storageMode, remoteServerUrl } = s.dataSyncConfig;
  if (!s.isInitRemoteServerConfig || !active || s.tenantEndpointChanged) return null;
  // Main still restores selfHost sessions from before tenant-bound logins.
  // A present but unusable binding must never fall back to this older shape.
  if (cloudTenant === undefined && storageMode === 'selfHost') {
    try {
      return JSON.stringify(['selfHost', buildRemoteUrl('', remoteServerUrl || '').href]);
    } catch {
      return null;
    }
  }
  if (!cloudTenant) return null;
  const { entryUrl, generation, identity } = cloudTenant;
  if (!entryUrl || !generation || !identity?.tenantId || !identity.subject || !identity.issuer)
    return null;
  return JSON.stringify([
    entryUrl,
    generation,
    identity.tenantId,
    identity.subject,
    identity.issuer,
  ]);
};

/**
 * The address this renderer builds every absolute link, asset URL and business request on.
 * It follows the main process (`RemoteServerConfigCtr.getRemoteServerUrl`): the committed tenant
 * entry (`https://host/t/acme`, or a custom-domain root), else the legacy self-hosted address.
 * A cloud login without a committed tenant has none (`''`); the platform origin is never a
 * fallback, because every business path on it fails with TENANT_REQUIRED.
 *
 * It is normalized (no trailing slash, query or hash) so callers can append an app path to it;
 * mount a server-returned path with `resolveRemoteUrl` / `buildRemoteUrl` from
 * `@lobechat/utils/remoteUrl` rather than `new URL(path, address)`, which drops the tenant path.
 *
 * Undefined outside the desktop renderer: the web app reads its own address from the tenant
 * package and never gets here.
 */
const remoteServerUrl = (s: ElectronState) => {
  const { cloudTenant, remoteServerUrl, storageMode } = s.dataSyncConfig;
  if (cloudTenant?.entryUrl) return normalizeRemoteBaseUrl(cloudTenant.entryUrl);
  return storageMode === 'selfHost' ? normalizeRemoteBaseUrl(remoteServerUrl || '') : '';
};

/**
 * Returns the raw remoteServerUrl from config without transformation.
 * Use this when you need the original configured value (e.g., for editing forms).
 */
const rawRemoteServerUrl = (s: ElectronState) => s.dataSyncConfig.remoteServerUrl || '';

/** The organization of the committed login, which partitions this renderer's local state. */
const committedTenantId = (s: ElectronState) =>
  s.dataSyncConfig.cloudTenant?.identity?.tenantId || undefined;

// Cloud mode is the build's official cloud, whatever tenant entry the login committed.
const isOfficialServer = (s: ElectronState) =>
  isOfficialCloudServer(
    storageMode(s) === 'cloud'
      ? process.env.OFFICIAL_CLOUD_SERVER || OFFICIAL_URL
      : remoteServerUrl(s),
  );

export const electronSyncSelectors = {
  committedTenantId,
  isOfficialServer,
  isSyncActive,
  rawRemoteServerUrl,
  remoteServerUrl,
  serverConfigScope,
  storageMode,
};
