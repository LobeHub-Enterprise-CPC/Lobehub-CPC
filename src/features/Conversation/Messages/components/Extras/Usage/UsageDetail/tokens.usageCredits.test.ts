import type * as BusinessConstModule from '@lobechat/business-const';
import type { LobeDefaultAiModelListItem } from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import { getDetailsToken } from './tokens';

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConstModule>()),
  USAGE_CREDITS: { creditsPerUsd: 373.8, inputCreditsAt1x: 50 },
}));

// ¥2 input, ¥8 output, ¥0.4 cached input per 1M tokens.
const modelCard = {
  id: 'm',
  pricing: {
    currency: 'CNY',
    units: [
      { name: 'textInput', rate: 2, strategy: 'fixed', unit: 'millionTokens' },
      { name: 'textOutput', rate: 8, strategy: 'fixed', unit: 'millionTokens' },
      { name: 'textInput_cacheRead', rate: 0.4, strategy: 'fixed', unit: 'millionTokens' },
    ],
  },
  type: 'chat',
} as unknown as LobeDefaultAiModelListItem;

const usage = {
  inputCacheMissTokens: 15_000,
  inputCachedTokens: 35_000,
  totalInputTokens: 50_000,
  totalOutputTokens: 5000,
  totalTokens: 55_000,
};

describe('usage detail in a distribution that charges in credits', () => {
  it('prices each row in its credits', () => {
    const detail = getDetailsToken(usage, modelCard);

    // 15K × ¥2, 35K × ¥0.4 and 5K × ¥8 per 1M, each × 52.5.
    expect(detail.inputCacheMiss?.credit).toBeCloseTo(1.575, 2);
    expect(detail.inputCached?.credit).toBeCloseTo(0.735, 2);
    expect(detail.totalOutput?.credit).toBeCloseTo(2.1, 2);
  });

  it('adds the rows up when the call carries no billed cost', () => {
    expect(getDetailsToken(usage, modelCard).totalTokens?.credit).toBeCloseTo(4.41, 1);
  });

  it('shows the billed cost as the total, not its own re-pricing of the rows', () => {
    // The bill can differ from the headline rates (a higher tier, a cache-write
    // TTL). What was charged is what the total has to say.
    const detail = getDetailsToken({ ...usage, cost: 0.02 }, modelCard);

    expect(detail.totalTokens?.credit).toBe(7.476);
  });
});
