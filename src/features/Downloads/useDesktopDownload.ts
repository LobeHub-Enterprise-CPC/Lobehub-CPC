import { useAppBaseUrl } from '@lobechat/business-tenant/client';
import { DOWNLOAD_URL } from '@lobechat/const';

import { isCustomBranding } from '@/const/version';
import { serverConfigSelectors, useServerConfigStore } from '@/store/serverConfig';

import type { DesktopDownloadTarget } from './resolveDesktopDownload';
import { resolveDesktopDownload } from './resolveDesktopDownload';

/**
 * Where "get the desktop app" should lead, and whether to offer it at all.
 *
 * See `resolveDesktopDownload` for the rule. Read this rather than linking to
 * `DOWNLOAD_URL` directly: that constant is the hosted site's, so a rebranded
 * build using it sends its users to somebody else's installer.
 */
export const useDesktopDownload = (): DesktopDownloadTarget => {
  const urls = useServerConfigStore(serverConfigSelectors.desktopDownloads);
  const appBaseUrl = useAppBaseUrl();

  return resolveDesktopDownload({
    appBaseUrl,
    fallbackUrl: DOWNLOAD_URL.default,
    isCustomBranding,
    urls,
  });
};
