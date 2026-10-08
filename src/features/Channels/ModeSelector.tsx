import type { ChannelMode } from '@lobechat/types';
import { Flexbox, Icon } from '@lobehub/ui';
import { Popover } from '@lobehub/ui/base-ui';
import { cssVar, cx } from 'antd-style';
import { ChevronDownIcon, MessageCircleIcon, MessagesSquareIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { styles } from '@/features/ChatInput/ControlBar/modeSelectorStyles';

const modes = [
  { value: 'normal', icon: MessageCircleIcon },
  { value: 'discussion', icon: MessagesSquareIcon },
] as const;

export function ModeSelector({
  value,
  onChange,
}: {
  value: ChannelMode;
  onChange: (value: ChannelMode) => void;
}) {
  const { t } = useTranslation('channel');
  const [open, setOpen] = useState(false);
  return (
    <Popover
      className={styles.popoverPopup}
      open={open}
      placement="topLeft"
      trigger="click"
      content={
        <Flexbox
          aria-label={t('mode.select')}
          gap={4}
          role="group"
          style={{ maxWidth: 320, minWidth: 280 }}
        >
          {modes.map((mode) => (
            <button
              aria-pressed={value === mode.value}
              key={mode.value}
              type="button"
              className={cx(
                styles.nativeButton,
                styles.option,
                value === mode.value && styles.activeOption,
              )}
              onClick={() => {
                onChange(mode.value);
                setOpen(false);
              }}
            >
              <Flexbox horizontal align="center" gap={12}>
                <Flexbox
                  align="center"
                  className={styles.optionIcon}
                  height={32}
                  justify="center"
                  width={32}
                >
                  <Icon icon={mode.icon} size={16} />
                </Flexbox>
                <Flexbox flex={1}>
                  <span className={styles.optionTitle}>{t(`mode.${mode.value}`)}</span>
                  <span className={styles.optionDesc}>{t(`mode.${mode.value}Description`)}</span>
                </Flexbox>
              </Flexbox>
            </button>
          ))}
        </Flexbox>
      }
      styles={{
        content: {
          border: `1px solid ${cssVar.colorBorderSecondary}`,
          borderRadius: cssVar.borderRadiusLG,
          padding: 4,
        },
      }}
      onOpenChange={setOpen}
    >
      <button
        aria-label={t('mode.select')}
        className={cx(styles.nativeButton, styles.button)}
        type="button"
      >
        <Icon icon={value === 'discussion' ? MessagesSquareIcon : MessageCircleIcon} size={14} />
        <span>{t(`mode.${value}`)}</span>
        <Icon icon={ChevronDownIcon} size={12} />
      </button>
    </Popover>
  );
}
