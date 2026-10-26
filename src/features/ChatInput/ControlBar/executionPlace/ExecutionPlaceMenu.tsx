'use client';

import { HETEROGENEOUS_TYPE_LABELS } from '@lobechat/heterogeneous-agents';
import { Flexbox, Icon } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { CheckIcon, CloudIcon, GlobeIcon, LaptopIcon } from 'lucide-react';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExecutionTargetController } from '../useExecutionTargetController';
import type { ExecutionPlace } from './resolveExecutionPlace';
import { styles } from './style';

interface ExecutionPlaceMenuProps {
  /** Web cannot run on this computer. */
  localDisabled: boolean;
  model: ExecutionTargetController;
  onCloud: () => void;
  onHover: (place: ExecutionPlace) => void;
  onLocal: () => void;
  onRemote: () => void;
  place: ExecutionPlace;
  showDesktopDownload: boolean;
}

export const ExecutionPlaceMenu = ({
  localDisabled,
  model,
  onCloud,
  onHover,
  onLocal,
  onRemote,
  place,
  showDesktopDownload,
}: ExecutionPlaceMenuProps) => {
  const { t } = useTranslation('chat');
  const cloudDisabled = !model.supportsSandbox;
  const cloudReason = t('heteroAgent.executionTarget.sandboxUnsupported', {
    name: model.heteroType ? HETEROGENEOUS_TYPE_LABELS[model.heteroType] : undefined,
  });

  return (
    <Flexbox data-testid={'execution-place-menu'} gap={2} {...stylex.props(styles.menu)}>
      <PlaceItem
        active={place === 'local'}
        disabled={localDisabled}
        icon={LaptopIcon}
        id={'local'}
        title={t('heteroAgent.executionPlace.local')}
        desc={
          localDisabled
            ? t('heteroAgent.executionPlace.localDesktopOnly')
            : t('heteroAgent.executionPlace.localDesc')
        }
        extra={
          localDisabled && showDesktopDownload ? (
            <a
              data-testid={'execution-place-desktop-download'}
              href={model.desktopDownload.href}
              rel={'noreferrer'}
              target={'_blank'}
              onClick={(event) => event.stopPropagation()}
              {...stylex.props(styles.chooseLink)}
            >
              {t('heteroAgent.executionTarget.downloadDesktop')}
            </a>
          ) : null
        }
        onClick={onLocal}
        onHover={() => onHover('local')}
      />
      <PlaceItem
        active={place === 'cloud'}
        desc={cloudDisabled ? cloudReason : t('heteroAgent.executionPlace.cloudDesc')}
        disabled={cloudDisabled}
        icon={CloudIcon}
        id={'cloud'}
        title={t('heteroAgent.executionPlace.cloud')}
        onClick={onCloud}
        onHover={() => onHover('cloud')}
      />
      <PlaceItem
        active={place === 'remote'}
        desc={t('heteroAgent.executionPlace.remoteDesc')}
        icon={GlobeIcon}
        id={'remote'}
        title={t('heteroAgent.executionPlace.remote')}
        onClick={onRemote}
        onHover={() => onHover('remote')}
      />
    </Flexbox>
  );
};

const PlaceItem = ({
  active,
  desc,
  disabled,
  extra,
  icon,
  id,
  onClick,
  onHover,
  title,
}: {
  active: boolean;
  desc: string;
  disabled?: boolean;
  extra?: ReactNode;
  icon: typeof LaptopIcon;
  id: ExecutionPlace;
  onClick: () => void;
  onHover: () => void;
  title: string;
}) => (
  <button
    aria-disabled={disabled || undefined}
    data-active={active ? 'true' : 'false'}
    data-testid={`execution-place-item-${id}`}
    // A download link sits inside the web-local row. Native `disabled` would
    // swallow that click, so the row refuses its own action and stays grey.
    disabled={disabled && !extra}
    type={'button'}
    onClick={() => {
      if (disabled) return;
      onClick();
    }}
    onMouseEnter={() => {
      if (disabled) return;
      onHover();
    }}
    {...stylex.props(styles.item, active && styles.itemActive, disabled && styles.itemDisabled)}
  >
    <span {...stylex.props(styles.itemIcon)}>
      <Icon icon={icon} size={16} />
    </span>
    <span {...stylex.props(styles.itemMeta)}>
      <span {...stylex.props(styles.itemTitle)}>{title}</span>
      <span {...stylex.props(styles.itemDesc)}>{desc}</span>
      {extra}
    </span>
    {active ? (
      <span data-testid={`execution-place-check-${id}`}>
        <Icon icon={CheckIcon} size={16} {...stylex.props(styles.check)} />
      </span>
    ) : null}
  </button>
);
