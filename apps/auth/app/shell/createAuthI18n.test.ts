import { BRANDING_NAME } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { isBrandPostProcessorEnabled } from '@/locales/brandPostProcessor';

import { createAuthI18n } from './createAuthI18n';

// The standalone auth SPA owns its i18next instance and has no branding layer
// above the translations, so the brand post-processor has to be registered here:
// sign-in, API-key and OAuth-consent copy names the product inline across the
// `auth` / `common` / `oauth` / `marketAuth` namespaces.
//
// Skipped under default branding, where the processor is not registered and the
// upstream name is correct.
describe('createAuthI18n branding', () => {
  it('rewrites upstream brand literals in translated copy', async () => {
    if (!isBrandPostProcessorEnabled) return;

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
