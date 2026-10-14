'use client';

import type { AgentAvatarGallery } from '@lobechat/business-const';
import { Flexbox } from '@lobehub/ui';
import { Button, Text } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: center;
  `,
  option: css`
    cursor: pointer;

    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    padding: 4px;
    border: 2px solid transparent;
    border-radius: 50%;

    background: transparent;

    transition: border-color ${cssVar.motionDurationFast};

    &:hover {
      border-color: ${cssVar.colorBorder};
    }

    &[aria-checked='true'] {
      border-color: ${cssVar.colorPrimary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }
  `,
  swatch: css`
    width: 28px;
    height: 28px;
    border-radius: 50%;
  `,
}));

interface AgentAvatarGalleryPickerProps {
  gallery: AgentAvatarGallery;
  onChange: (avatar: string) => void;
  onReset: () => void;
  /** The agent's stored avatar; `null` / `undefined` means it shows the default. */
  value?: string | null;
}

/**
 * Shape × colour picker for a distribution's avatar gallery. Each pick resolves
 * to the URL of that combination, which the caller stores as the avatar.
 */
const AgentAvatarGalleryPicker = memo<AgentAvatarGalleryPickerProps>(
  ({ gallery, onChange, onReset, value }) => {
    const { t } = useTranslation('setting');
    // An avatar from outside the gallery has no combination to start from, so
    // the first pick builds on the default one.
    const current = gallery.parse(value) ?? gallery.parse(gallery.defaultAvatar);

    return (
      <Flexbox data-brand-slot={'agent-avatar-gallery'} gap={20} padding={20} width={304}>
        <Flexbox horizontal align={'center'} justify={'space-between'}>
          <Text fontSize={16} weight={600}>
            {t('settingAgent.avatarGallery.title')}
          </Text>
          <Button disabled={!value} size={'small'} type={'link'} onClick={onReset}>
            {t('settingAgent.avatarGallery.reset')}
          </Button>
        </Flexbox>
        <div
          aria-label={t('settingAgent.avatarGallery.shape')}
          className={styles.grid}
          role={'radiogroup'}
        >
          {gallery.shapes.map(({ key, preview }) => (
            <button
              aria-checked={current?.shape === key}
              aria-label={key}
              className={styles.option}
              key={key}
              role={'radio'}
              type={'button'}
              onClick={() => onChange(gallery.resolve({ color: current?.color ?? '', shape: key }))}
            >
              <img alt={''} draggable={false} height={44} src={preview} width={44} />
            </button>
          ))}
        </div>
        <div
          aria-label={t('settingAgent.avatarGallery.color')}
          className={styles.grid}
          role={'radiogroup'}
        >
          {gallery.colors.map(({ key, swatch }) => (
            <button
              aria-checked={current?.color === key}
              aria-label={key}
              className={styles.option}
              key={key}
              role={'radio'}
              type={'button'}
              onClick={() => onChange(gallery.resolve({ color: key, shape: current?.shape ?? '' }))}
            >
              <span className={styles.swatch} style={{ background: swatch }} />
            </button>
          ))}
        </div>
      </Flexbox>
    );
  },
);

AgentAvatarGalleryPicker.displayName = 'AgentAvatarGalleryPicker';

export default AgentAvatarGalleryPicker;
