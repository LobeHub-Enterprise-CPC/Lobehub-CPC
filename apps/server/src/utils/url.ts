import { BRANDING_NAME, OFFICIAL_URL } from '@lobechat/business-const';
import urlJoin from 'url-join';

const isVercelPreview = process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'production';

const vercelPreviewUrl = `https://${process.env.VERCEL_URL}`;

const siteUrl =
  (BRANDING_NAME as string) !== 'LobeHub'
    ? process.env.APP_URL || OFFICIAL_URL
    : isVercelPreview
      ? vercelPreviewUrl
      : 'https://lobechat.com';

export const getCanonicalUrl = (...paths: string[]) =>
  urlJoin(...(/^https?:\/\//.test(paths[0] || '') ? paths : [siteUrl, ...paths]));
