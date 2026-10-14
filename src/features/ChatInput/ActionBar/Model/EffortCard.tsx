import { ActionIcon } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ReasoningEffortControl } from '../../hooks/useReasoningEffortControl';
import { resolveReasoningEffortValue } from '../../hooks/useReasoningEffortControl';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    position: relative;

    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: center;

    padding-block: 12px 8px;
    padding-inline: 8px;
  `,
  level: css`
    font-size: 16px;
    font-weight: 600;
    line-height: 24px;
    color: ${cssVar.colorPrimary};
  `,
  reset: css`
    position: absolute;
    inset-block-start: 8px;
    inset-inline-end: 8px;
  `,
  stop: css`
    cursor: pointer;

    position: relative;
    z-index: 1;

    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    height: 100%;
    padding: 0;
    border: none;

    background: transparent;

    &::after {
      content: '';

      width: 4px;
      height: 4px;
      border-radius: 50%;

      background: ${cssVar.colorTextQuaternary};
    }

    &[data-passed]::after {
      opacity: 0.6;
      background: ${cssVar.colorBgContainer};
    }

    &[data-current]::after {
      width: 20px;
      height: 20px;

      opacity: 1;
      background: ${cssVar.colorBgContainer};
      box-shadow: 0 1px 3px color-mix(in srgb, ${cssVar.colorText} 20%, transparent);
    }

    &:disabled {
      cursor: default;
    }
  `,
  track: css`
    position: relative;

    overflow: hidden;
    display: flex;

    width: 100%;
    height: 28px;
    margin-block-start: 8px;
    border-radius: 9999px;

    background: ${cssVar.colorFillSecondary};
  `,
  trackFill: css`
    pointer-events: none;

    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;

    border-radius: 9999px;

    background: ${cssVar.colorPrimary};

    transition: width 0.2s ease;
  `,
}));

interface EffortCardProps {
  effort: ReasoningEffortControl;
  model: string;
  /** The model row (name + submenu trigger) rendered under the level. */
  modelSlot: ReactNode;
}

/**
 * Reasoning effort as a stepped slider heading the model menu: the current
 * level reads as the title, the model sits under it, and each stop is one of
 * the model's own effort levels.
 */
const EffortCard = memo<EffortCardProps>(({ effort, model, modelSlot }) => {
  const { t } = useTranslation('chat');
  const { effortKey, effortLevels, effortValue, select, updating } = effort;

  if (!effortKey) return <div className={styles.card}>{modelSlot}</div>;

  const currentIndex = effortValue ? effortLevels.indexOf(effortValue) : -1;
  const defaultLevel = resolveReasoningEffortValue(model, effortKey, undefined);
  const stopWidth = 100 / effortLevels.length;

  return (
    <div
      className={styles.card}
      data-brand-slot={'composer-effort-card'}
      data-effort-max={currentIndex === effortLevels.length - 1 || undefined}
    >
      <span className={styles.level}>
        {effortValue ? t(`reasoningEffort.levels.${effortValue}`) : t('reasoningEffort.title')}
      </span>
      {modelSlot}
      {defaultLevel && (
        <ActionIcon
          className={styles.reset}
          disabled={updating || effortValue === defaultLevel}
          icon={RefreshCwIcon}
          size={'small'}
          title={t('reasoningEffort.reset')}
          onClick={() => select({ [effortKey]: defaultLevel })}
        />
      )}
      <div aria-label={t('reasoningEffort.title')} className={styles.track} role={'radiogroup'}>
        {currentIndex > 0 && (
          <div
            className={styles.trackFill}
            data-brand-slot={'composer-effort-fill'}
            style={{ width: `${stopWidth * (currentIndex + 1)}%` }}
          />
        )}
        {effortLevels.map((level, index) => (
          <button
            aria-checked={index === currentIndex}
            aria-label={t(`reasoningEffort.levels.${level}`)}
            className={styles.stop}
            data-current={index === currentIndex || undefined}
            data-passed={index < currentIndex || undefined}
            disabled={updating}
            key={level}
            role={'radio'}
            type={'button'}
            onClick={() => select({ [effortKey]: level })}
          />
        ))}
      </div>
    </div>
  );
});

EffortCard.displayName = 'ModelEffortCard';

export default EffortCard;
