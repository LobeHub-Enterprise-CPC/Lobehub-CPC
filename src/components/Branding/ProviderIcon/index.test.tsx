import { describe, expect, it } from 'vitest';

import { ProviderIcon as SharedProviderIcon } from '@/components/LobeIcons';

import { ProviderIcon } from './index';

describe('Branding ProviderIcon', () => {
  it('cannot diverge from the shared provider resolver', () => {
    expect(ProviderIcon).toBe(SharedProviderIcon);
  });
});
