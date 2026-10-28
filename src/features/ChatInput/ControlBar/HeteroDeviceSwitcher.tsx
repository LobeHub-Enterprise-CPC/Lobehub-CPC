'use client';

import { isDesktop } from '@lobechat/const';
import { HETEROGENEOUS_TYPE_LABELS } from '@lobechat/heterogeneous-agents';
import type { DeviceExecutionTarget } from '@lobechat/types';
import {
  Button,
  createStaticStyles,
  cssVar,
  cx,
  Flexbox,
  Icon,
  Popover,
  Tooltip,
} from '@lobehub/ui';
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  InfoIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { memo, type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import InstantSwitch from '@/components/InstantSwitch';
import { ExecutionTargetIcon } from '@/features/ExecutionTargetPicker';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';

import { formatLockedControlTooltip } from '../utils/lockedControlTooltip';
import { ExecutionTargetDeviceList } from './ExecutionTargetDeviceList';
import OptionRow from './OptionRow';
import { deviceRowTags, useExecutionTargetController } from './useExecutionTargetController';

const styles = createStaticStyles(({ css }) => ({
  button: css`
    cursor: pointer;

    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;

    padding-block: 2px;
    padding-inline: 4px;
    border-radius: 4px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;

    transition: all 0.2s;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  buttonLabel: css`
    overflow: hidden;
    max-width: 120px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  buttonReadonly: css`
    cursor: default;

    &:hover {
      color: ${cssVar.colorTextSecondary};
      background: transparent;
    }
  `,
  extraInfo: css`
    cursor: help;

    display: flex;
    align-items: center;

    color: ${cssVar.colorTextQuaternary};

    transition: color 0.2s;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  header: css`
    display: flex;
    gap: 6px;
    align-items: center;
    justify-content: space-between;

    padding-block: 4px;
    padding-inline: 8px;
  `,
  headerInfo: css`
    cursor: help;
    color: ${cssVar.colorTextQuaternary};
    transition: color 0.2s;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  headerLink: css`
    display: flex;
    gap: 3px;
    align-items: center;

    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
    text-decoration: none;

    transition: color 0.2s;

    &:hover {
      color: ${cssVar.colorPrimary};
    }
  `,
  headerTitle: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextTertiary};
  `,
  manageButton: css`
    cursor: pointer;

    display: flex;
    gap: 3px;
    align-items: center;

    padding: 0;
    border: none;

    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};

    background: none;

    transition: color 0.2s;

    &:hover {
      color: ${cssVar.colorPrimary};
    }
  `,
}));

interface HeteroDeviceSwitcherProps {
  agentId: string;
}

const HeteroDeviceSwitcher = memo<HeteroDeviceSwitcherProps>(({ agentId }) => {
  const { t } = useTranslation('chat');
  const navigate = useWorkspaceAwareNavigate();
  const model = useExecutionTargetController(agentId);
  const {
    boundDevice,
    boundDeviceId,
    canShowExecutionTarget,
    canShowExecutionTargetSelector,
    canUseLocalSandbox,
    chipExecutionTarget,
    currentDeviceId,
    desktopDownload,
    executionTarget,
    handleInstallSandbox,
    handleToggleSandboxNetwork,
    heteroType,
    isActive,
    isHetero,
    isInstallingSandbox,
    localSandboxEnabled,
    localSandboxNetwork,
    open,
    sandboxCapability,
    selectTarget,
    setOpen,
    showHeaderDownloadLink,
    supportsSandbox,
    topicDeviceId,
    topicDeviceUnknown,
  } = model;

  const handleSelect = useCallback(
    async (target: DeviceExecutionTarget, deviceId?: string, localSandbox?: boolean) => {
      setOpen(false);
      await selectTarget(target, deviceId, localSandbox);
    },
    [selectTarget, setOpen],
  );

  if (!canShowExecutionTarget) return null;

  let chipIcon: ReactNode = <ExecutionTargetIcon target={'sandbox'} />;
  let chipLabel = t('heteroAgent.executionTarget.sandbox');
  if (chipExecutionTarget === 'none') {
    chipIcon = <ExecutionTargetIcon target={'none'} />;
    chipLabel = t('heteroAgent.executionTarget.none');
  } else if (chipExecutionTarget === 'auto') {
    chipIcon = <ExecutionTargetIcon target={'auto'} />;
    chipLabel = t('heteroAgent.executionTarget.auto');
  } else if (chipExecutionTarget === 'local') {
    chipIcon = <ExecutionTargetIcon target={canShowExecutionTargetSelector ? 'local' : 'device'} />;
    chipLabel = t(
      canShowExecutionTargetSelector
        ? 'heteroAgent.executionTarget.local'
        : 'heteroAgent.executionTarget.workspaceGroup',
    );
    if (canShowExecutionTargetSelector && localSandboxEnabled) {
      chipIcon = <Icon icon={ShieldCheckIcon} size={14} />;
      chipLabel = t('heteroAgent.executionTarget.localSandbox');
    }
  } else if (chipExecutionTarget === 'device') {
    chipIcon = <ExecutionTargetIcon devicePlatform={boundDevice?.platform} target={'device'} />;
    chipLabel = canShowExecutionTargetSelector
      ? (boundDevice?.friendlyName ??
        boundDevice?.hostname ??
        t('heteroAgent.executionTarget.unknownDevice'))
      : t('heteroAgent.executionTarget.workspaceGroup');
  }
  const isMachineChip = chipExecutionTarget === 'local' || chipExecutionTarget === 'device';
  if (topicDeviceUnknown && canShowExecutionTargetSelector && isMachineChip) {
    chipIcon = <ExecutionTargetIcon target={'device'} />;
    chipLabel = t('heteroAgent.executionTarget.unknownDevice');
  }

  const effectiveMachineId =
    executionTarget === 'device'
      ? boundDeviceId
      : executionTarget === 'local'
        ? (currentDeviceId ?? boundDeviceId)
        : undefined;
  const topicTag =
    topicDeviceId && effectiveMachineId === topicDeviceId
      ? t('heteroAgent.executionTarget.topicTag')
      : undefined;
  const tagsFor = (active: boolean, tags: ReactNode[] = []) =>
    deviceRowTags(active, topicTag, tags);

  const content = (
    <Flexbox style={{ maxWidth: 320, minWidth: 280 }}>
      <div className={styles.header}>
        <Flexbox horizontal align={'center'} gap={4}>
          <span className={styles.headerTitle}>{t('heteroAgent.executionTarget.title')}</span>
          <Tooltip title={t('heteroAgent.executionTarget.infoTooltip')}>
            <span className={styles.headerInfo}>
              <Icon icon={InfoIcon} size={12} />
            </span>
          </Tooltip>
        </Flexbox>
        {showHeaderDownloadLink ? (
          <a
            className={styles.headerLink}
            href={desktopDownload.href}
            rel="noreferrer"
            target="_blank"
          >
            <Icon icon={ExternalLinkIcon} size={11} />
            <span>{t('heteroAgent.executionTarget.downloadDesktop')}</span>
          </a>
        ) : (
          <button
            className={styles.manageButton}
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/settings/devices');
            }}
          >
            <Icon icon={SettingsIcon} size={11} />
            <span>{t('heteroAgent.executionTarget.manage')}</span>
          </button>
        )}
      </div>
      {isHetero ? null : (
        <OptionRow
          active={isActive('none')}
          desc={t('heteroAgent.executionTarget.noneDesc')}
          icon={<ExecutionTargetIcon target={'none'} />}
          label={t('heteroAgent.executionTarget.none')}
          onClick={() => void handleSelect('none')}
        />
      )}
      {isHetero ? null : (
        <OptionRow
          active={isActive('auto')}
          desc={t('heteroAgent.executionTarget.autoDesc')}
          icon={<ExecutionTargetIcon target={'auto'} />}
          label={t('heteroAgent.executionTarget.auto')}
          onClick={() => void handleSelect('auto')}
        />
      )}
      {isDesktop ? (
        <OptionRow
          active={isActive('local')}
          desc={t('heteroAgent.executionTarget.localDesc')}
          icon={<ExecutionTargetIcon target={'local'} />}
          label={t('heteroAgent.executionTarget.local')}
          tags={tagsFor(isActive('local'))}
          onClick={() => void handleSelect('local', undefined, false)}
        />
      ) : null}
      {isDesktop ? (
        <OptionRow
          active={executionTarget === 'local' && localSandboxEnabled}
          disabled={!canUseLocalSandbox}
          icon={<Icon icon={ShieldCheckIcon} size={14} />}
          label={t('heteroAgent.executionTarget.localSandbox')}
          tags={tagsFor(executionTarget === 'local' && localSandboxEnabled)}
          desc={
            canUseLocalSandbox
              ? t(
                  localSandboxNetwork
                    ? 'heteroAgent.executionTarget.localSandboxDescNetwork'
                    : 'heteroAgent.executionTarget.localSandboxDesc',
                )
              : (sandboxCapability?.instructions ??
                t('heteroAgent.executionTarget.localSandboxUnavailable', {
                  reason: sandboxCapability?.reason ?? '',
                }))
          }
          extra={
            canUseLocalSandbox ? (
              <>
                <InstantSwitch
                  enabled={localSandboxNetwork}
                  size={'small'}
                  onChange={handleToggleSandboxNetwork}
                />
                <Tooltip title={t('heteroAgent.executionTarget.localSandboxNetworkTip')}>
                  <span className={styles.extraInfo}>
                    <Icon icon={InfoIcon} size={12} />
                  </span>
                </Tooltip>
              </>
            ) : sandboxCapability?.canInstall ? (
              <Button loading={isInstallingSandbox} size={'small'} onClick={handleInstallSandbox}>
                {t('heteroAgent.executionTarget.localSandboxSetUp')}
              </Button>
            ) : undefined
          }
          onClick={() => void handleSelect('local', undefined, true)}
        />
      ) : null}
      <OptionRow
        active={isActive('sandbox')}
        disabled={!supportsSandbox}
        icon={<ExecutionTargetIcon target={'sandbox'} />}
        label={t('heteroAgent.executionTarget.sandbox')}
        desc={t(
          supportsSandbox
            ? 'heteroAgent.executionTarget.sandboxDesc'
            : 'heteroAgent.executionTarget.sandboxUnsupported',
          { name: heteroType ? HETEROGENEOUS_TYPE_LABELS[heteroType] : undefined },
        )}
        onClick={() => void handleSelect('sandbox')}
      />
      <ExecutionTargetDeviceList
        model={model}
        topicTag={topicTag}
        onSelectDevice={(deviceId) => void handleSelect('device', deviceId)}
      />
    </Flexbox>
  );

  const chip = (
    <div className={cx(styles.button, !canShowExecutionTargetSelector && styles.buttonReadonly)}>
      {chipIcon}
      <span className={styles.buttonLabel}>{chipLabel}</span>
      {canShowExecutionTargetSelector ? <Icon icon={ChevronDownIcon} size={12} /> : null}
    </div>
  );

  if (!canShowExecutionTargetSelector)
    return (
      <Tooltip
        title={formatLockedControlTooltip(chipLabel, t('heteroAgent.executionTarget.fixedTip'))}
      >
        {chip}
      </Tooltip>
    );

  return (
    <Popover
      content={content}
      open={open}
      placement="topLeft"
      styles={{ content: { padding: 4 } }}
      trigger="click"
      onOpenChange={setOpen}
    >
      {chip}
    </Popover>
  );
});

HeteroDeviceSwitcher.displayName = 'HeteroDeviceSwitcher';

export default HeteroDeviceSwitcher;
