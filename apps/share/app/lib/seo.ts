import { BRANDING_LOGO_URL, BRANDING_NAME, OFFICIAL_URL, ORG_NAME } from '@lobechat/business-const';
import type { MetaDescriptor } from 'react-router';

// Shared with landing-rr: upstream share pages ship behind the lobehub.com
// gateway, so the landing's OG artwork is the brand card for these pages too.
// Absolute URL on purpose — OG scrapers do not resolve relative image paths.
const UPSTREAM_OG_IMAGE_URL = 'https://lobehub.com/assets/cao-og.webp';
const UPSTREAM_TWITTER_SITE = '@lobehub';

// A white-label build has no upstream card, and pointing its own share pages at
// lobehub.com advertises the upstream brand — the same reason the `spa-share`
// HTML route resolves `OG_URL` against `OFFICIAL_URL`. Resolve the deployment's
// logo through the business-const slot, and keep the upstream card only when
// the slot is empty (i.e. when this is upstream itself).
const OG_IMAGE_URL = BRANDING_LOGO_URL
  ? new URL(BRANDING_LOGO_URL, OFFICIAL_URL).href
  : UPSTREAM_OG_IMAGE_URL;

// `@lobehub` is upstream's handle. `isCustomORG` is `ORG_NAME !== 'LobeHub'`
// (packages/const/src/version.ts): a branded deployment has no counterpart
// account, so the tag is dropped rather than pointing at upstream's — matching
// the main app's `metadata.ts` and this repo's `spa-share` route, which both
// omit `twitter:site` under custom branding.
const TWITTER_SITE = ORG_NAME === 'LobeHub' ? UPSTREAM_TWITTER_SITE : undefined;

type DescriptionKey = 'artifactDescription' | 'pageDescription' | 'topicDescription';

const FALLBACK_DESCRIPTION: Record<DescriptionKey, string> = {
  artifactDescription: `An artifact shared from ${BRANDING_NAME}.`,
  pageDescription: `A page shared from ${BRANDING_NAME}.`,
  topicDescription: `A conversation shared from ${BRANDING_NAME}.`,
};

export const shareMetaDescription = (resources: unknown, key: DescriptionKey): string => {
  const chat = (resources as Record<string, Record<string, unknown>> | undefined)?.chat;
  const text = chat?.[`sharePage.meta.${key}`];

  return typeof text === 'string'
    ? text.replaceAll('{{appName}}', BRANDING_NAME)
    : FALLBACK_DESCRIPTION[key];
};

export const truncateDescription = (text: string | null | undefined, max = 200) => {
  if (!text) return undefined;
  const clean = text.replaceAll(/\s+/g, ' ').trim();
  if (!clean) return undefined;

  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

interface BuildPageMetaOptions {
  description: string;
  locale?: string;
  title: string;
  type?: 'article' | 'website';
}

export const buildPageMeta = ({
  description,
  locale = 'en-US',
  title,
  type = 'website',
}: BuildPageMetaOptions): MetaDescriptor[] => [
  { title },
  { content: description, name: 'description' },
  // Mirrors the apex robots.txt, which disallows /share/*: shared links are
  // meant to be passed around, not indexed. OG scrapers still read the card.
  { content: 'noindex, nofollow', name: 'robots' },
  { content: title, property: 'og:title' },
  { content: description, property: 'og:description' },
  { content: type, property: 'og:type' },
  { content: BRANDING_NAME, property: 'og:site_name' },
  { content: locale.replace('-', '_'), property: 'og:locale' },
  { content: OG_IMAGE_URL, property: 'og:image' },
  { content: title, property: 'og:image:alt' },
  { content: 'summary_large_image', name: 'twitter:card' },
  ...(TWITTER_SITE ? [{ content: TWITTER_SITE, name: 'twitter:site' }] : []),
  { content: title, name: 'twitter:title' },
  { content: description, name: 'twitter:description' },
  { content: OG_IMAGE_URL, name: 'twitter:image' },
];
