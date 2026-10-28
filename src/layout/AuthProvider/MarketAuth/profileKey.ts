import { getTenant } from '@lobechat/business-tenant/client';

import { type MarketUserInfo } from './types';

/**
 * What to look the signed-in user's Market profile up by.
 *
 * Market's userinfo answers with the numeric `accountId` of the person acting,
 * and the profile endpoint accepts it. `sub` is a different thing: in an
 * organization (tenant) deployment it identifies the user in the tenant's own
 * account space (the CPC user id the trust token was signed for), which is not
 * a Market username and names no profile — or, worse, names an unrelated one
 * that happens to share the spelling. It only doubles as a username in a
 * community deployment, so it is a fallback there and never in a tenant document.
 */
export const getMarketProfileKey = (
  userInfo: Pick<MarketUserInfo, 'accountId' | 'sub'> | null | undefined,
  isTenantDocument: boolean = Boolean(getTenant()?.slug),
): string | null => {
  if (!userInfo) return null;

  const { accountId, sub } = userInfo;
  if (Number.isSafeInteger(accountId) && accountId > 0) return String(accountId);

  return isTenantDocument ? null : sub || null;
};
