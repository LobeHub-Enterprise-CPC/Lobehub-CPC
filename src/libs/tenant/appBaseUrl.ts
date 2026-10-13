import { getTenant } from '@lobechat/business-tenant/client';
import { isDesktop } from '@lobechat/const';
import { buildRemoteUrl, resolveRemoteUrl } from '@lobechat/utils/remoteUrl';

import { getElectronStoreState } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';

/**
 * The address app paths live under, for links and assets built outside the SPA
 * router (downloads opened in a new tab, server-relative image paths).
 *
 * - Web: the page origin plus the tenant path — `https://host/t/acme` on the
 *   default entry, the bare origin on a custom-domain entry.
 * - Desktop: the configured remote server address. The renderer is served from
 *   its own origin and has no tenant, so the page cannot tell where the app is.
 *
 * Mount a path with `buildRemoteUrl` / `resolveRemoteUrl` from
 * `@lobechat/utils/remoteUrl`; `new URL(path, address)` drops the tenant path.
 */
export const getAppBaseUrl = (): string => {
  if (isDesktop) return electronSyncSelectors.remoteServerUrl(getElectronStoreState());

  return `${window.location.origin}${getTenant()?.basePath ?? ''}`;
};

/**
 * A server-returned URL (uploaded file, avatar, banner) that may be a
 * server-relative path, made absolute under {@link getAppBaseUrl}. Absolute,
 * protocol-relative, `data:` and `blob:` values are returned as they are.
 */
export const resolveAppUrl = (value: string): string => resolveRemoteUrl(value, getAppBaseUrl());

/**
 * Absolute URL of an app page (path, query allowed) under {@link getAppBaseUrl},
 * e.g. an OAuth `redirect_uri` that must land back in this tenant's app.
 */
export const buildAppUrl = (path: string): string =>
  buildRemoteUrl(path, getAppBaseUrl()).toString();
