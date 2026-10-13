'use client';

import { isDesktop } from '@lobechat/const';

import { useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';

/**
 * Returns the base URL app links are built on (share links, copied page links,
 * webhook and install URLs): callers append an app path (`${appOrigin}/agent/...`).
 * - Web: uses window.location.origin
 * - Desktop: uses the remote server address from the electron store. That is a
 *   tenant address (`https://host/t/acme`) or a custom-domain root, normalized
 *   without a trailing slash, so it keeps the tenant path prefix the links need.
 *   Do not feed it to `new URL(path, appOrigin)` — that drops the prefix; use
 *   `buildRemoteUrl` from `@lobechat/utils/remoteUrl`.
 */
export const useAppOrigin = () => {
  const remoteServerUrl = useElectronStore(electronSyncSelectors.remoteServerUrl);
  return isDesktop ? remoteServerUrl : window.location.origin;
};
