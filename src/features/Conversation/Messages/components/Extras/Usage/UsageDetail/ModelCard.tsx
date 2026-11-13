import {
  formatUsageCreditRate,
  getCachedTextInputUnitRate,
  getWriteCacheInputUnitRate,
  isUsageCreditsEnabled,
  usageCreditRate,
} from '@lobechat/utils';
import { createStaticStyles, Flexbox, Icon, Tabs, Tooltip } from '@lobehub/ui';
import { ArrowDownToDot, ArrowUpFromDot, BookUp2Icon, CircleFadingArrowUp } from 'lucide-react';
import { type LobeDefaultAiModelListItem } from 'model-bank';
import { getProviderDisplayName } from 'model-bank/modelProviders';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ModelIcon } from '@/components/LobeIcons';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';

import { getPrice } from './pricing';

export const styles = createStaticStyles(({ css, cssVar }) => {
  return {
    container: css`
      font-size: 12px;
    `,
    desc: css`
      line-height: 12px;
      color: ${cssVar.colorTextDescription};
    `,
    pricing: css`
      font-size: 12px;
      color: ${cssVar.colorTextSecondary};
    `,
  };
});

interface ModelCardProps extends LobeDefaultAiModelListItem {
  provider: string;
}

const ModelCard = memo<ModelCardProps>(({ pricing, id, provider, displayName }) => {
  const { t } = useTranslation(['chat', 'common']);

  const isShowCredit = useGlobalStore(systemStatusSelectors.isShowCredit) && !!pricing;
  const updateSystemStatus = useGlobalStore((s) => s.updateSystemStatus);

  const usdPrice = getPrice(pricing || { units: [] });
  // A distribution that charges in its own credits quotes its rates in them and
  // never shows the dollar price behind them.
  const isUsageCredits = isUsageCreditsEnabled();
  const quote = (usdPerMillion: number) =>
    isUsageCredits ? formatUsageCreditRate(usageCreditRate(usdPerMillion)) : usdPerMillion;
  const formatPrice = {
    cachedInput: quote(usdPrice.cachedInput),
    input: quote(usdPrice.input),
    output: quote(usdPrice.output),
    writeCacheInput: quote(usdPrice.writeCacheInput),
  };
  const rateTitle = (
    unit: 'cachedInput' | 'cacheWrite' | 'input' | 'output',
    amount: number | string,
  ) => {
    if (isUsageCredits) return t(`usageCredits.rate.${unit}`, { amount, ns: 'common' });

    switch (unit) {
      case 'cachedInput': {
        return t('messages.modelCard.pricing.inputCachedTokens', { amount });
      }
      case 'cacheWrite': {
        return t('messages.modelCard.pricing.writeCacheInputTokens', { amount });
      }
      case 'input': {
        return t('messages.modelCard.pricing.inputTokens', { amount });
      }
      default: {
        return t('messages.modelCard.pricing.outputTokens', { amount });
      }
    }
  };

  return (
    <Flexbox gap={8}>
      <Flexbox
        horizontal
        align={'center'}
        className={styles.container}
        flex={1}
        gap={40}
        justify={'space-between'}
      >
        <Flexbox horizontal align={'center'} gap={8}>
          <ModelIcon model={id} size={22} />
          <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
            <Flexbox horizontal align={'center'} gap={8} style={{ lineHeight: '12px' }}>
              {displayName || id}
            </Flexbox>
            <span className={styles.desc}>{getProviderDisplayName(provider)}</span>
          </Flexbox>
        </Flexbox>
        {!!pricing && (
          <Flexbox>
            <Tabs
              activeKey={isShowCredit ? 'credit' : 'token'}
              size={'small'}
              items={[
                { key: 'token', label: 'Token' },
                {
                  key: 'credit',
                  label: (
                    <Tooltip
                      title={
                        isUsageCredits
                          ? t('usageCredits.tooltip', { ns: 'common' })
                          : t('messages.modelCard.creditTooltip')
                      }
                    >
                      <span>
                        {isUsageCredits
                          ? t('usageCredits.name', { ns: 'common' })
                          : t('messages.modelCard.credit')}
                      </span>
                    </Tooltip>
                  ),
                },
              ]}
              onChange={(key) => {
                updateSystemStatus({ isShowCredit: key === 'credit' });
              }}
            />
          </Flexbox>
        )}
      </Flexbox>
      {isShowCredit ? (
        <Flexbox horizontal justify={'space-between'}>
          <div />
          <Flexbox horizontal align={'center'} className={styles.pricing} gap={8}>
            {t('messages.modelCard.creditPricing')}:
            {getCachedTextInputUnitRate(pricing) && (
              <Tooltip title={rateTitle('cachedInput', formatPrice.cachedInput)}>
                <Flexbox horizontal gap={2}>
                  <Icon icon={CircleFadingArrowUp} />
                  {formatPrice.cachedInput}
                </Flexbox>
              </Tooltip>
            )}
            {getWriteCacheInputUnitRate(pricing) && (
              <Tooltip title={rateTitle('cacheWrite', formatPrice.writeCacheInput)}>
                <Flexbox horizontal gap={2}>
                  <Icon icon={BookUp2Icon} />
                  {formatPrice.writeCacheInput}
                </Flexbox>
              </Tooltip>
            )}
            <Tooltip title={rateTitle('input', formatPrice.input)}>
              <Flexbox horizontal gap={2}>
                <Icon icon={ArrowUpFromDot} />
                {formatPrice.input}
              </Flexbox>
            </Tooltip>
            <Tooltip title={rateTitle('output', formatPrice.output)}>
              <Flexbox horizontal gap={2}>
                <Icon icon={ArrowDownToDot} />
                {formatPrice.output}
              </Flexbox>
            </Tooltip>
          </Flexbox>
        </Flexbox>
      ) : (
        <div style={{ height: 18 }} />
      )}
    </Flexbox>
  );
});

export default ModelCard;
