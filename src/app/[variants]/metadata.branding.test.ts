// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { generateMetadata } from './metadata';

vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_NAME: 'Private Workspace',
  ORG_NAME: 'Private Workspace',
  BRANDING_LOGO_URL: '/branding/logo.png',
  OFFICIAL_URL: 'https://private.example',
  APPLE_APP_STORE_ID: '',
}));
vi.mock('@/utils/server/routeVariants', () => ({
  RouteVariants: { getLocale: async () => 'en-US' },
}));
vi.mock('@/libs/i18n/serverTranslation', () => ({
  translation: async () => ({ t: () => 'Private Workspace' }),
}));
it('uses the private image and omits a nonexistent customer social account', async () => {
  const metadata = await generateMetadata({} as any);
  expect(metadata.twitter.site).toBeUndefined();
  expect(metadata.openGraph.images[0].url).toBe('/branding/logo.png');
  expect(metadata.openGraph.images[0].width).toBeUndefined();
  expect(JSON.stringify(metadata)).not.toMatch(/lobehub|lobechat|@Private/i);
});
