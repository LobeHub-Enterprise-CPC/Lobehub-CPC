import {
  formatUsageCredits,
  isUsageCreditsEnabled,
  usdToUsageCredits,
} from '@lobechat/utils/usageCredits';
import { t } from 'i18next';

/**
 * A cost as text that stands on its own, with its unit: "$1.23", or
 * "4.4 Credits" where the distribution charges in credits. Use
 * `formatUsageCost` instead when an icon or a column title already names the unit.
 */
export const formatUsageCostLabel = (usd: number, formatUsd: (usd: number) => string): string =>
  isUsageCreditsEnabled()
    ? t('usageCredits.amount', {
        amount: formatUsageCredits(usdToUsageCredits(usd)),
        ns: 'common',
      })
    : formatUsd(usd);

/**
 * The unit to print after a bare amount — a statistic, say — where `$` used to
 * sit in front of it. Nothing for a distribution that keeps dollars.
 */
export const usageAmountSuffix = (): string | undefined =>
  isUsageCreditsEnabled() ? ` ${t('usageCredits.name', { ns: 'common' })}` : undefined;
