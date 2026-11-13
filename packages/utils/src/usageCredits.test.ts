import { describe, expect, it, vi } from 'vitest';

// 7.12 CNY per USD × 1.05 markup × 50 credits per CNY.
const RATE = { creditsPerUsd: 373.8, inputCreditsAt1x: 50 };

const load = async (config: typeof RATE | undefined) => {
  vi.resetModules();
  vi.doMock('@lobechat/business-const', () => ({ USAGE_CREDITS: config }));
  return import('./usageCredits');
};

describe('usage credits', () => {
  describe('a distribution that charges in credits', () => {
    it('restates a USD cost at its rate', async () => {
      const { usdToUsageCredits, usageCreditsToUsd } = await load(RATE);

      expect(usdToUsageCredits(1)).toBe(373.8);
      expect(usageCreditsToUsd(373.8)).toBeCloseTo(1, 10);
    });

    it('rounds a charge up to 0.001 credit, so a call that cost something is never free', async () => {
      const { usdToUsageCredits } = await load(RATE);

      expect(usdToUsageCredits(0.000_001)).toBe(0.001);
      expect(usdToUsageCredits(0.011_79)).toBe(4.408);
      expect(usdToUsageCredits(0)).toBe(0);
    });

    it('does not add a step for binary noise on an exact amount', async () => {
      const { usdToUsageCredits } = await load({ ...RATE, creditsPerUsd: 4.41 });

      // 4.41 * 1000 is 4410.000000000001 in floating point.
      expect(usdToUsageCredits(1)).toBe(4.41);
    });

    it('quotes a directory rate in credits whatever currency it is priced in', async () => {
      const { usageCreditRate } = await load(RATE);

      // ¥6 per 1M tokens × 1.05 × 50.
      expect(usageCreditRate(6, 'CNY')).toBeCloseTo(315, 6);
      expect(usageCreditRate(1, 'USD')).toBeCloseTo(373.8, 6);
      expect(usageCreditRate(1)).toBeCloseTo(373.8, 6);
    });

    it("counts a model's relative price against the distribution's 1× rate", async () => {
      const { usageCreditBaseline, usageCreditMultiplier } = await load(RATE);

      // ¥6 input → 315 credits per 1M → 6.3×, i.e. input CNY price × 1.05.
      expect(usageCreditMultiplier(6, 'CNY')).toBeCloseTo(6.3, 6);
      expect(usageCreditBaseline()).toBe('50');
    });

    it('formats a charge to one decimal, keeping three below 0.1', async () => {
      const { formatUsageCredits } = await load(RATE);

      expect(formatUsageCredits(4.41)).toBe('4.4');
      expect(formatUsageCredits(1668)).toBe('1,668.0');
      expect(formatUsageCredits(0.1)).toBe('0.1');
      expect(formatUsageCredits(0.042)).toBe('0.042');
      expect(formatUsageCredits(0.001)).toBe('0.001');
      expect(formatUsageCredits(0)).toBe('0');
    });

    it('formats a rate as a price list reads: whole from 10, two digits below', async () => {
      const { formatUsageCreditRate } = await load(RATE);

      expect(formatUsageCreditRate(1575)).toBe('1,575');
      expect(formatUsageCreditRate(315)).toBe('315');
      expect(formatUsageCreditRate(15.75)).toBe('16');
      expect(formatUsageCreditRate(6.3)).toBe('6.3');
      expect(formatUsageCreditRate(0.2136)).toBe('0.21');
    });

    it('shows a cost in credits and drops the dollar sign', async () => {
      const { formatUsageCost, usageAmount, usageAmountPrefix } = await load(RATE);

      expect(formatUsageCost(1, (usd) => `$${usd.toFixed(2)}`)).toBe('373.8');
      expect(usageAmount(0.5)).toBe(186.9);
      expect(usageAmountPrefix()).toBe('');
    });

    it('takes a budget in credits and stores it in USD', async () => {
      const { usageBudgetFromInput, usageBudgetToInput } = await load(RATE);

      const stored = usageBudgetFromInput(100);
      expect(stored).toBeCloseTo(100 / 373.8, 10);
      expect(usageBudgetToInput(stored)).toBe(100);
      expect(usageBudgetToInput(null)).toBeNull();
      expect(usageBudgetFromInput(null)).toBeNull();
    });
  });

  describe('a distribution that keeps dollars', () => {
    it('leaves every amount as it was', async () => {
      const m = await load(undefined);

      expect(m.isUsageCreditsEnabled()).toBe(false);
      expect(m.formatUsageCost(1.234, (usd) => `$${usd.toFixed(2)}`)).toBe('$1.23');
      expect(m.usageAmount(1.234)).toBe(1.234);
      expect(m.usageAmountPrefix()).toBe('$');
      expect(m.usageCreditMultiplier(6, 'CNY')).toBeUndefined();
      expect(m.usageBudgetToInput(2.5)).toBe(2.5);
      expect(m.usageBudgetFromInput(2.5)).toBe(2.5);
    });
  });
});
