import { USAGE_CREDITS } from '@lobechat/business-const';
import { USD_TO_CNY } from '@lobechat/const/currency';
import type { ModelPriceCurrency } from 'model-bank';

/** A charge is kept to 0.001 credit and rounded up, so no call is ever free. */
const CHARGE_PRECISION = 1000;

/** Whether this distribution states usage in credits rather than dollars. */
export const isUsageCreditsEnabled = (): boolean => !!USAGE_CREDITS;

const toUsd = (amount: number, currency?: ModelPriceCurrency | string) =>
  currency === 'CNY' ? amount / USD_TO_CNY : amount;

/**
 * Credits charged for a USD cost. Only meaningful when credits are enabled;
 * returns the amount unchanged otherwise so callers can't silently mix units.
 */
export const usdToUsageCredits = (usd: number): number => {
  if (!USAGE_CREDITS) return usd;
  if (!(usd > 0)) return 0;

  const credits = usd * USAGE_CREDITS.creditsPerUsd;
  // The epsilon keeps binary noise (4.41 → 4.410000000000001) from adding a step.
  return Math.ceil(credits * CHARGE_PRECISION - 1e-6) / CHARGE_PRECISION;
};

/** The USD cost that a credit amount stands for — the inverse of `usdToUsageCredits`. */
export const usageCreditsToUsd = (credits: number): number =>
  USAGE_CREDITS ? credits / USAGE_CREDITS.creditsPerUsd : credits;

/**
 * Credits per pricing unit (per million tokens, per image, per second…) for a
 * rate from the model directory.
 */
export const usageCreditRate = (rate: number, currency?: ModelPriceCurrency | string): number =>
  USAGE_CREDITS ? toUsd(rate, currency) * USAGE_CREDITS.creditsPerUsd : toUsd(rate, currency);

/**
 * A model's relative price: its input rate against the distribution's 1× rate.
 * `undefined` when the distribution does not use credits.
 */
export const usageCreditMultiplier = (
  inputRate: number,
  currency?: ModelPriceCurrency | string,
): number | undefined =>
  USAGE_CREDITS ? usageCreditRate(inputRate, currency) / USAGE_CREDITS.inputCreditsAt1x : undefined;

/** Credits per 1M input tokens that count as 1×, formatted for the price tooltip. */
export const usageCreditBaseline = (): string | undefined =>
  USAGE_CREDITS ? formatUsageCreditRate(USAGE_CREDITS.inputCreditsAt1x) : undefined;

/**
 * A USD amount as the number the user should read: credits when the
 * distribution uses them, dollars otherwise. For charts, statistics and
 * anything else that needs the value rather than its text.
 */
export const usageAmount = (usd: number): number => (USAGE_CREDITS ? usdToUsageCredits(usd) : usd);

/**
 * A stored USD budget as the number an input shows, and what the user typed
 * back as the USD to store. `null` (no cap) passes through.
 */
export const usageBudgetToInput = (usd: number | null | undefined): number | null =>
  typeof usd === 'number' ? usageAmount(usd) : null;

export const usageBudgetFromInput = (value: number | null | undefined): number | null =>
  typeof value === 'number' ? usageCreditsToUsd(value) : null;

/** `$` in front of a dollar amount, nothing in front of a credit one. */
export const usageAmountPrefix = (): string => (USAGE_CREDITS ? '' : '$');

const group = (value: number, fractionDigits: number) =>
  value.toLocaleString('en-US', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  });

/**
 * A charged amount: one decimal, which is what a balance is read to. Below 0.1
 * that would print "0.0" for a call that did cost something, so small amounts
 * keep the three decimals they are charged at.
 */
export const formatUsageCredits = (credits: number): string => {
  if (!Number.isFinite(credits) || credits <= 0) return '0';
  if (credits >= 0.0995) return group(credits, 1);

  return String(Number(credits.toFixed(3)));
};

/**
 * A per-unit rate: whole credits from 10 up, two significant digits below
 * (315, 63, 6.3, 0.21) — the precision a price list is compared at.
 */
export const formatUsageCreditRate = (credits: number): string => {
  if (!Number.isFinite(credits) || credits <= 0) return '0';
  if (credits >= 9.95) return group(Math.round(credits), 0);

  return String(Number(credits.toPrecision(2)));
};

/**
 * A cost for display: credits when the distribution uses them, otherwise
 * whatever dollar format the surface already had.
 */
export const formatUsageCost = (usd: number, formatUsd: (usd: number) => string): string =>
  USAGE_CREDITS ? formatUsageCredits(usdToUsageCredits(usd)) : formatUsd(usd);
