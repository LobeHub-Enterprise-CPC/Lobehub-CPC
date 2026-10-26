import { BRANDING_LOGO_URL, BRANDING_NAME } from '@lobechat/business-const';
import { isCustomBranding } from '@lobechat/const';
import urlJoin from 'url-join';

import { appEnv } from '@/envs/app';

import { escapeHtml } from './support';

// The emoji mark is upstream's brand. A distribution that renames the product
// but supplies no logo gets the name alone rather than another vendor's mark.
const DEFAULT_MARK = '🤯';

// Mail clients resolve images against nothing, so a site-relative logo path has
// to be joined onto the app's public origin. SVG and data: URIs are not used
// here: Gmail and Outlook drop both, so BRANDING_LOGO_URL must point at a raster.
const getEmailLogoUrl = (): string | undefined => {
  if (!BRANDING_LOGO_URL) return undefined;
  if (/^https?:\/\//.test(BRANDING_LOGO_URL)) return BRANDING_LOGO_URL;
  return urlJoin(appEnv.APP_URL!, BRANDING_LOGO_URL);
};

const getMarkHtml = () => {
  const logoUrl = getEmailLogoUrl();

  // The name renders beside the mark, so the image is decorative for screen
  // readers and for clients that block remote images.
  if (logoUrl)
    return `<img src="${escapeHtml(logoUrl)}" width="24" height="24" alt="" style="display: inline-block; width: 24px; height: 24px; border: 0; margin-right: 10px; vertical-align: middle;">`;

  if (isCustomBranding) return '';

  return `<span style="font-size: 24px; line-height: 1; margin-right: 10px;">${DEFAULT_MARK}</span>`;
};

/**
 * Brand header shared by every transactional email template.
 */
export const getEmailBrandHeaderHtml = () => `<!-- Logo -->
    <div style="text-align: center; margin-bottom: 32px;">
      <div style="display: inline-flex; align-items: center; justify-content: center; background-color: #ffffff; border-radius: 12px; padding: 8px 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        ${getMarkHtml()}
        <span style="font-size: 18px; font-weight: 700; color: #000000; letter-spacing: -0.5px;">${escapeHtml(BRANDING_NAME)}</span>
      </div>
    </div>`;
