import { describe, expect, it, vi } from 'vitest';

import { applyBrandStrings, isBrandPostProcessorEnabled } from './brandPostProcessor';

// Pin upstream defaults even when this suite runs inside a white-label workspace.
vi.mock('@lobechat/const', () => ({
  BRANDING_AGENT_TITLE: 'Lobe Agent',
  BRANDING_NAME: 'LobeHub',
  DEFAULT_INBOX_TITLE: 'Lobe AI',
  LOBE_CHAT_CLOUD: 'LobeHub Cloud',
}));

describe('brand strings under default branding', () => {
  it('preserves the current product, cloud, assistant and capability names', () => {
    const value = 'LobeHub / LobeHub Cloud / Lobe AI / Lobe Agent / @LobeHub';

    expect(applyBrandStrings(value)).toBe(value);
  });

  it('still enables normalization of legacy names without a white-label override', () => {
    expect(isBrandPostProcessorEnabled).toBe(true);
    expect(applyBrandStrings('LobeChat / LobeAI / Lobe-Agent')).toBe(
      'LobeHub / Lobe AI / Lobe Agent',
    );
  });
});
