import { BRANDING_NAME, isCustomBranding, OFFICIAL_SITE } from '@lobechat/const';

/**
 * App attribution for OpenRouter-style gateways (`HTTP-Referer` + `X-Title`).
 * The gateway shows it in the customer's own usage console and in its public
 * app rankings, so a rebranded build names itself and sends no vendor site.
 */
export const appAttributionHeaders = (): Record<string, string> => ({
  ...(isCustomBranding ? {} : { 'HTTP-Referer': OFFICIAL_SITE }),
  'X-Title': BRANDING_NAME,
});

/**
 * AiHubMix `APP-Code`: a referral code registered to an app's domain, which
 * credits that app and discounts the calls made through it. The upstream code
 * belongs to LobeHub, so a rebranded build sends none rather than another
 * vendor's.
 */
export const aiHubMixAppCodeHeaders = (): Record<string, string> =>
  isCustomBranding ? {} : { 'APP-Code': 'LobeHub' };
