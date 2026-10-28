import { BRANDING_NAME } from '@lobechat/const';
import { describe, expect, it, vi } from 'vitest';

import { createShareI18n } from './createShareI18n';

// Keep the white-label contract independent of the checkout's business override.
vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BRANDING_NAME: 'Acme Workspace',
}));

// The share SPA owns its i18next instance and has no branding layer above the
// translations, so the brand post-processor has to be registered here: without
// it the literals baked into `chat` / `error` / `pageShare` reach a white-label
// visitor verbatim, which is what INC-009 recorded for the share disclaimer.
describe('createShareI18n branding', () => {
  it('rewrites upstream brand literals in translated copy', async () => {
    const { init, instance } = createShareI18n('en-US', {
      chat: { sample: 'Go to LobeHub' },
    });
    await init({ initAsync: false });

    const value = instance.t('sample');
    expect(value).not.toContain('LobeHub');
    expect(value).toContain(BRANDING_NAME);
  });
});
