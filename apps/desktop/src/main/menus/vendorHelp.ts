import { DOWNLOAD_URL } from '@lobechat/const/url';
import type { MenuItemConstructorOptions } from 'electron';

import { isCustomBranding } from '@/const/branding';
import { OFFICIAL_CLOUD_SERVER } from '@/const/env';

export { isCustomBranding };

/**
 * The Help menu's website, GitHub repository and issue entries open the
 * vendor's own site and tracker. A rebranded build ships under another name
 * and has none of these, so the entries — with the separator that closes them
 * off, or the menu would open on a divider — are dropped rather than sending
 * users to a different product.
 */
export const vendorHelpItems = (
  items: MenuItemConstructorOptions[],
  rebranded: boolean = isCustomBranding,
): MenuItemConstructorOptions[] => (rebranded ? [] : [...items, { type: 'separator' }]);

/**
 * Where "Update unavailable" sends a build that cannot replace itself.
 *
 * Upstream's downloads page lists a different product's installers. A
 * rebranded build points at its own server — the one it was packaged for —
 * which is where that deployment publishes its client.
 */
export const updateDownloadUrl = (
  rebranded: boolean = isCustomBranding,
  server: string | undefined = OFFICIAL_CLOUD_SERVER,
): string => (rebranded && server ? server : DOWNLOAD_URL.default);
