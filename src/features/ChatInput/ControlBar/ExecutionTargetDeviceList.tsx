'use client';

import { isDesktop } from '@lobechat/const';
import { Icon } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { ExternalLinkIcon, MonitorDownIcon } from 'lucide-react';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import DeviceOptionRow from './DeviceOptionRow';
import { ExecutionPlaceRemoteEmpty } from './executionPlace/ExecutionPlaceRemoteEmpty';
import { deviceRowTags, type ExecutionTargetController } from './useExecutionTargetController';

const styles = stylex.create({
  desc: {
    alignItems: 'center',
    color: cssVar.colorTextDescription,
    display: 'flex',
    fontSize: 11,
    gap: 6,
  },
  deviceList: {
    marginInlineEnd: -4,
    maxHeight: 240,
    overflowY: 'auto',
    paddingInlineEnd: 4,
  },
  downloadCard: {
    alignItems: 'center',
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: cssVar.borderRadius,
    cursor: 'pointer',
    display: 'flex',
    gap: 10,
    paddingBlock: 8,
    paddingInline: 8,
    textDecoration: 'none',
    transitionDuration: '0.2s',
    transitionProperty: 'background-color',
  },
  downloadCardArrow: {
    color: cssVar.colorTextQuaternary,
    flex: 'none',
    marginInlineStart: 'auto',
  },
  empty: {
    color: cssVar.colorTextQuaternary,
    fontSize: 12,
    paddingBlock: 8,
    paddingInline: 8,
  },
  groupLabel: {
    color: cssVar.colorTextQuaternary,
    fontSize: 11,
    fontWeight: 500,
    paddingBlock: 4,
    paddingInline: 8,
  },
  optionIcon: {
    alignItems: 'center',
    backgroundColor: cssVar.colorBgElevated,
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: cssVar.borderRadius,
    borderStyle: 'solid',
    borderWidth: 1,
    color: cssVar.colorText,
    display: 'flex',
    flex: 'none',
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  optionMeta: {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    gap: 1,
    minWidth: 0,
  },
  optionTitle: {
    color: cssVar.colorText,
    fontSize: 13,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

interface ExecutionTargetDeviceListProps {
  /**
   * `panel` renders the place picker's panel-styled empty states instead of
   * the legacy menu copy. The legacy menu keeps `default` untouched.
   */
  emptyVariant?: 'default' | 'panel';
  model: ExecutionTargetController;
  onSelectDevice: (deviceId: string) => void;
  topicTag?: ReactNode;
}

/**
 * Remote-device rows, groups, and empty states. The legacy menu and the place
 * picker's remote panel both mount this, so reconnect / enrollment copy stays
 * in one place.
 */
export const ExecutionTargetDeviceList = ({
  emptyVariant = 'default',
  model,
  onSelectDevice,
  topicTag,
}: ExecutionTargetDeviceListProps) => {
  const { t } = useTranslation('chat');
  const {
    agentWorkspaceId,
    cliBin,
    currentDeviceId,
    desktopDownload,
    deviceRows,
    handleReconnectDevice,
    isActive,
    isPoolEmpty,
    isWorkspaceAgent,
    personalOnlyDevices,
    poolStatus,
    privateDevices,
    reconnectingDeviceId,
    refreshDevices,
    showDeviceGroups,
    showWebDownloadCard,
    showWorkspaceEnrollHint,
    workspaceDevices,
  } = model;

  const renderDeviceRow = (device: (typeof deviceRows)[number]) => {
    const isCurrentMachine = device.deviceId === currentDeviceId;
    const active = isActive('device', device.deviceId);
    return (
      <DeviceOptionRow
        active={active}
        device={device}
        isCurrentMachine={isCurrentMachine}
        key={device.deviceId}
        reconnecting={reconnectingDeviceId === device.deviceId}
        tags={deviceRowTags(
          active,
          topicTag,
          isCurrentMachine ? [t('heteroAgent.executionTarget.gateway')] : [],
        )}
        onReconnect={() => void handleReconnectDevice(device.deviceId)}
        onSelect={() => onSelectDevice(device.deviceId)}
      />
    );
  };

  return (
    <>
      {deviceRows.length > 0 ? (
        showDeviceGroups ? (
          <>
            {privateDevices.length > 0 ? (
              <>
                <div {...stylex.props(styles.groupLabel)}>
                  {t('heteroAgent.executionTarget.personalGroup')}
                </div>
                <div {...stylex.props(styles.deviceList)}>
                  {privateDevices.map((device) => renderDeviceRow(device))}
                </div>
              </>
            ) : null}
            {workspaceDevices.length > 0 ? (
              <>
                <div {...stylex.props(styles.groupLabel)}>
                  {t('heteroAgent.executionTarget.workspaceGroup')}
                </div>
                <div {...stylex.props(styles.deviceList)}>
                  {workspaceDevices.map((device) => renderDeviceRow(device))}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <div {...stylex.props(styles.deviceList)}>
            {personalOnlyDevices.map((device) => renderDeviceRow(device))}
          </div>
        )
      ) : null}
      {emptyVariant === 'panel' ? (
        <ExecutionPlaceRemoteEmpty model={model} />
      ) : (
        <>
          {poolStatus === 'loading' ? (
            <div {...stylex.props(styles.empty)}>{t('heteroAgent.executionTarget.loading')}</div>
          ) : null}
          {poolStatus === 'error' ? (
            <div {...stylex.props(styles.empty)}>
              {t('heteroAgent.executionTarget.loadFailed')}{' '}
              <a
                role="button"
                onClick={() => {
                  void refreshDevices();
                }}
              >
                {t('retry', { ns: 'common' })}
              </a>
            </div>
          ) : null}
          {showWorkspaceEnrollHint ? (
            <div {...stylex.props(styles.empty)}>
              {t('heteroAgent.executionTarget.noWorkspaceDevices', {
                cmd: `${cliBin} connect --workspace ${agentWorkspaceId}`,
              })}
            </div>
          ) : null}
          {showWebDownloadCard ? (
            <a
              href={desktopDownload.href}
              rel="noreferrer"
              target="_blank"
              {...stylex.props(styles.downloadCard)}
            >
              <div {...stylex.props(styles.optionIcon)}>
                <Icon icon={MonitorDownIcon} size={14} />
              </div>
              <div {...stylex.props(styles.optionMeta)}>
                <div {...stylex.props(styles.optionTitle)}>
                  {t('heteroAgent.executionTarget.downloadDesktopTitle')}
                </div>
                <div {...stylex.props(styles.desc)}>
                  {t('heteroAgent.executionTarget.downloadDesktopDesc')}
                </div>
              </div>
              <Icon icon={ExternalLinkIcon} size={13} {...stylex.props(styles.downloadCardArrow)} />
            </a>
          ) : null}
          {isPoolEmpty && isDesktop && !isWorkspaceAgent ? (
            <div {...stylex.props(styles.empty)}>
              {t('heteroAgent.executionTarget.noDevices', { cliBin })}
            </div>
          ) : null}
        </>
      )}
    </>
  );
};
