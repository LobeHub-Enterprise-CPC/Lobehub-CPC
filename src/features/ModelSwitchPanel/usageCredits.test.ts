import type * as BusinessConstModule from '@lobechat/business-const';
import type { Pricing } from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import { getPrice } from './hooks/useModelDetailPanel';
import { formatPriceMultiplier, getInputPriceMultiplier } from './utils';

// A distribution that charges 52.5 credits per CNY and counts 50 credits per
// 1M input tokens as 1×.
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConstModule>()),
  USAGE_CREDITS: { creditsPerUsd: 373.8, inputCreditsAt1x: 50 },
}));

const cnyPricing: Pricing = {
  currency: 'CNY',
  units: [
    { name: 'textInput', rate: 6, strategy: 'fixed', unit: 'millionTokens' },
    { name: 'textOutput', rate: 18, strategy: 'fixed', unit: 'millionTokens' },
    { name: 'textInput_cacheRead', rate: 0.3, strategy: 'fixed', unit: 'millionTokens' },
  ],
};

describe('model pricing in a distribution that charges in credits', () => {
  it('quotes rates in its credits, converting a CNY-priced model first', () => {
    const price = getPrice(cnyPricing, true);

    // ¥6 / ¥18 / ¥0.3 per 1M tokens × 52.5.
    expect(price.input.current).toBe('315');
    expect(price.output.current).toBe('945');
    expect(price.cachedInput.current).toBe('16');
  });

  it('prices a USD model at the same rate', () => {
    const price = getPrice(
      { units: [{ name: 'textInput', rate: 1, strategy: 'fixed', unit: 'millionTokens' }] },
      true,
    );

    expect(price.input.current).toBe('374');
  });

  it("shows the model's × against the distribution's 1× rate", () => {
    // 315 credits per 1M input ÷ 50 = input CNY price × 1.05.
    const multiplier = getInputPriceMultiplier(cnyPricing);

    expect(multiplier).toBeCloseTo(6.3, 6);
    expect(formatPriceMultiplier(multiplier!)).toBe('6.3');
  });
});
