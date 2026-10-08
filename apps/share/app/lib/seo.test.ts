import { BRANDING_LOGO_URL, OFFICIAL_URL, ORG_NAME } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { buildPageMeta } from './seo';

// The share SPA renders its own <Meta> through react-router and, unlike the
// main app, never registers the brand post-processor: every brand string it
// emits has to come from the business-const slot. The upstream OG card and the
// `@lobehub` handle used to be hardcoded here, so a white-label deployment
// advertised the upstream brand on its own share pages — document head and
// link previews — while its title and og:site_name were correctly branded.
//
// `ORG_NAME === 'LobeHub'` means upstream itself, where the upstream card and
// handle are correct, so the expectation flips instead of being skipped.
const isUpstream = ORG_NAME === 'LobeHub';

const UPSTREAM_OG_IMAGE_URL = 'https://lobehub.com/assets/cao-og.webp';
const UPSTREAM_TWITTER_SITE = '@lobehub';

const meta = buildPageMeta({
  description: 'A conversation shared from this deployment.',
  locale: 'zh-TW',
  title: 'Shared topic',
});
const emitted = JSON.stringify(meta);

const contentOf = (key: 'name' | 'property', value: string) =>
  (meta as Array<Record<string, string>>).find((tag) => tag[key] === value)?.content;

describe('share page metadata', () => {
  it('never advertises the upstream brand from a branded deployment', () => {
    if (isUpstream) {
      expect(emitted).toContain(UPSTREAM_OG_IMAGE_URL);
      expect(emitted).toContain(UPSTREAM_TWITTER_SITE);
      return;
    }

    expect(emitted).not.toContain('lobehub.com');
    expect(emitted).not.toContain(UPSTREAM_TWITTER_SITE);
  });

  it('resolves both card images through the business-const slot', () => {
    const expected = BRANDING_LOGO_URL
      ? new URL(BRANDING_LOGO_URL, OFFICIAL_URL).href
      : UPSTREAM_OG_IMAGE_URL;

    expect(contentOf('property', 'og:image')).toBe(expected);
    expect(contentOf('name', 'twitter:image')).toBe(expected);
  });

  it('drops twitter:site unless the deployment is upstream itself', () => {
    const expected = isUpstream ? UPSTREAM_TWITTER_SITE : undefined;

    expect(contentOf('name', 'twitter:site')).toBe(expected);
  });
});
