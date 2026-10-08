import { BRANDING_NAME } from '@lobechat/const';
import { describe, expect, it, vi } from 'vitest';

import { createAuthI18n } from './createAuthI18n';

// Keep the white-label contract independent of the checkout's business override.
vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BRANDING_NAME: 'Acme Workspace',
}));

// The standalone auth SPA owns its i18next instance and has no branding layer
// above the translations, so the brand post-processor has to be registered here:
// sign-in, API-key and OAuth-consent copy names the product inline across the
// `auth` / `common` / `oauth` / `marketAuth` namespaces.
describe('createAuthI18n branding', () => {
  it('rewrites upstream brand literals in translated copy', async () => {
    const { init, instance } = createAuthI18n({
      locale: 'en-US',
      resources: {
        auth: { sample: 'Sign in to LobeHub' },
        authError: {},
        common: {},
        error: {},
        marketAuth: {},
        oauth: {},
      },
    });
    await init();

    const value = instance.t('sample', { ns: 'auth' });
    expect(value).not.toContain('LobeHub');
    expect(value).toContain(BRANDING_NAME);
  });
});
