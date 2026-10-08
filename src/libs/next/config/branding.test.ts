// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { defineConfig } from './define-config';

vi.mock('@lobechat/business-const', () => ({ BRANDING_NAME: 'Private Workspace' }));
it('keeps private sitemap requests away from the upstream marketing site', async () => {
  const config = defineConfig({});
  const redirects = await config.redirects!();
  expect(redirects.some((r) => r.source.startsWith('/sitemap'))).toBe(false);
  expect(redirects).toContainEqual({
    source: '/manifest.json',
    destination: '/manifest.webmanifest',
    permanent: true,
  });
});
