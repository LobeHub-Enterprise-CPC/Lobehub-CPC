import type { MenuItemConstructorOptions } from 'electron';

import { isCustomBranding } from '@/const/branding';

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
