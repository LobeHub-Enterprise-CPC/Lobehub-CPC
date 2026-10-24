import type { DesktopDownloadUrls } from '@lobechat/types';

export interface DesktopDownloadTarget {
  /** Whether to offer "get the desktop app" at all. */
  available: boolean;
  /** Where the offer should lead. Undefined when `available` is false. */
  href?: string;
}

interface ResolveOptions {
  /**
   * The address this app is served under (`https://host/t/acme`). The offer is
   * opened as a plain link, outside the router, so the page's own tenant prefix
   * has to be part of it. Omitted, the link stays a root-relative `/downloads`.
   */
  appBaseUrl?: string;
  /** `DOWNLOAD_URL.default` — the hosted site's downloads page. */
  fallbackUrl: string;
  /** Whether this build has been rebranded away from upstream. */
  isCustomBranding: boolean;
  /** What the server reports, if this deployment publishes its own installers. */
  urls?: DesktopDownloadUrls;
}

/**
 * Decide where the product's "get the desktop app" entries should lead.
 *
 * Three cases, and the third is the one worth spelling out:
 *
 * 1. The deployment publishes its own installers → its own `/downloads`.
 * 2. Upstream, publishing none of its own → the hosted downloads page, which is
 *    that build's own site. Unchanged behaviour.
 * 3. A rebranded build publishing none → **nothing**. Falling through to the
 *    hosted page there sends users to a different product's installer, which is
 *    how these entry points became dead ends in the first place; a distribution
 *    that has not configured its downloads should show no offer rather than a
 *    wrong one.
 *
 * Case 1 is decided by server config rather than a compiled-in constant, so
 * moving the release hosting is an env change and a restart.
 */
export const resolveDesktopDownload = ({
  appBaseUrl = '',
  fallbackUrl,
  isCustomBranding,
  urls,
}: ResolveOptions): DesktopDownloadTarget => {
  const hasOwnDownloads = Boolean(urls && (urls.macOS || urls.windows));

  if (hasOwnDownloads)
    return { available: true, href: `${appBaseUrl.replace(/\/+$/, '')}/downloads` };
  if (isCustomBranding) return { available: false };

  return { available: true, href: fallbackUrl };
};
