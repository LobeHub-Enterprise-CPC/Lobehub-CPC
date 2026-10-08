import { BRANDING_NAME } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { isBrandPostProcessorEnabled } from '@/locales/brandPostProcessor';

import { createShareI18n } from './createShareI18n';

// The share SPA owns its i18next instance and has no branding layer above the
// translations, so the brand post-processor has to be registered here: without
// it the literals baked into `chat` / `error` / `pageShare` reach a white-label
// visitor verbatim, which is what INC-009 recorded for the share disclaimer.
//
// Skipped under default branding, where the processor is not registered and the
// upstream name is correct.
describe('createShareI18n branding', () => {
  it('rewrites upstream brand literals in translated copy', async () => {
    if (!isBrandPostProcessorEnabled) return;

    const { init, instance } = createShareI18n('en-US', {
      chat: { sample: 'Go to LobeHub' },
    });
    await init({ initAsync: false });

    const value = instance.t('sample');
    expect(value).not.toContain('LobeHub');
    expect(value).toContain(BRANDING_NAME);
  });
});
