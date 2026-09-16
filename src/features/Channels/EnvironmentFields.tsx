'use client';

import { isDesktop } from '@lobechat/const';
import type { WorkingDirEntry } from '@lobechat/types';
import { Flexbox, Icon, Input } from '@lobehub/ui';
import { Popover, Text } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import {
  CheckIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  SearchIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import DirIcon from '@/features/ChatInput/ControlBar/DirIcon';
import { ExecutionTargetDeviceStatus, ExecutionTargetIcon } from '@/features/ExecutionTargetPicker';
import { openAddWorkingDirModal } from '@/features/WorkingDirectory';
import { resolveAgentWorkingDirectory } from '@/helpers/agentWorkingDirectory';
import { getWorkingDirectoryName } from '@/helpers/workingDirectoryPath';
import { agentService } from '@/services/agent';
import { deviceService } from '@/services/device';
import { electronSystemService } from '@/services/electron/system';
import { useElectronStore } from '@/store/electron';

// Match the composer controls, but keep selection in the Channel member draft.
const styles = createStaticStyles(({ css }) => ({
  chip: css`
    cursor: pointer;

    display: flex;
    gap: 6px;
    align-items: center;

    min-width: 0;
    padding-block: 2px;
    padding-inline: 4px;
    border: 0;
    border-radius: 4px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: transparent;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `,
  chipLabel: css`
    overflow: hidden;
    max-width: 140px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  menu: css`
    width: 320px;
    max-width: calc(100vw - 48px);
  `,
  list: css`
    overflow-y: auto;
    max-height: 320px;
  `,
  row: css`
    cursor: pointer;

    display: flex;
    gap: 8px;
    align-items: center;

    width: 100%;
    padding: 8px;
    border: 0;
    border-radius: ${cssVar.borderRadius};

    color: ${cssVar.colorText};
    text-align: start;

    background: transparent;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
  `,
  active: css`
    background: ${cssVar.colorFillTertiary};
  `,
  deviceIcon: css`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 28px;
    height: 28px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorBgElevated};
  `,
  name: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  description: css`
    overflow: hidden;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  section: css`
    padding-block: 6px 2px;
    padding-inline: 8px;
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
  `,
}));

export type ChannelDevice = Awaited<ReturnType<typeof deviceService.listDevices>>[number];

export interface EnvironmentDraft {
  deviceId: string;
  workingDirectory: string;
}

export function EnvironmentFields({
  agentId,
  devices,
  disabled,
  hint,
  onChange,
  value,
}: {
  agentId: string;
  devices: ChannelDevice[];
  disabled?: boolean;
  /** Replaces the default "changes apply after saving" copy; `null` hides the line. */
  hint?: string | null;
  onChange: (draft: EnvironmentDraft) => void;
  value: EnvironmentDraft;
}) {
  const { t } = useTranslation('channel');
  const { t: deviceT } = useTranslation('device');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [search, setSearch] = useState('');
  const currentDeviceId = useElectronStore((s) => s.gatewayDeviceInfo?.deviceId);
  const { data: agent } = useSWR(['channel-environment-agent', agentId], () =>
    agentService.getAgentConfigById(agentId),
  );
  const selectedDevice = devices.find((device) => device.deviceId === value.deviceId);
  const locked = disabled || checking;
  const localDevice = isDesktop && !!currentDeviceId && currentDeviceId === value.deviceId;
  const directories = [
    ...new Map<string, WorkingDirEntry>(
      [
        ...[value.workingDirectory, selectedDevice?.defaultCwd]
          .filter(Boolean)
          .map((path) => ({ path: path! })),
        ...(selectedDevice?.workingDirs ?? []),
      ].map((entry) => [entry.path, entry]),
    ).values(),
  ];
  const filtered = directories.filter((entry) =>
    entry.path.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const pickDirectory = (path: string) => {
    onChange({ ...value, workingDirectory: path });
    setError('');
    setDirectoryOpen(false);
  };
  const changeDevice = (deviceId: string) => {
    const device = devices.find((item) => item.deviceId === deviceId);
    onChange({
      deviceId,
      workingDirectory:
        resolveAgentWorkingDirectory({
          agencyConfig: {
            ...agent?.agencyConfig,
            executionTarget: 'device',
            boundDeviceId: deviceId,
          },
          deviceDefaultCwd: device?.defaultCwd ?? undefined,
        }) ?? '',
    });
    setError('');
    setDeviceOpen(false);
  };
  const browse = async () => {
    setDirectoryOpen(false);
    setChecking(true);
    try {
      const result = await electronSystemService.selectFolder({
        defaultPath: value.workingDirectory || selectedDevice?.defaultCwd || undefined,
        title: t('environment.chooseFolder'),
      });
      if (result) pickDirectory(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('environment.checkFailed'));
    } finally {
      setChecking(false);
    }
  };
  const addRemoteDirectory = () => {
    setDirectoryOpen(false);
    openAddWorkingDirModal({
      placeholder: selectedDevice?.defaultCwd || undefined,
      onSubmit: async (path) => {
        try {
          const result = await deviceService.statPath(value.deviceId, path);
          if (result && !result.exists) return deviceT('workingDirectory.pathNotExist');
          if (result && !result.isDirectory) return deviceT('workingDirectory.pathNotDirectory');
          pickDirectory(path);
        } catch (cause) {
          return cause instanceof Error ? cause.message : t('environment.checkFailed');
        }
      },
    });
  };
  return (
    <Flexbox gap={8}>
      <Flexbox horizontal align="center" gap={8} wrap="wrap">
        <Popover
          open={deviceOpen && !locked}
          placement="bottomLeft"
          styles={{ content: { padding: 4 } }}
          trigger="click"
          content={
            <Flexbox className={styles.menu} gap={4}>
              <div className={styles.section}>{t('selectDevice')}</div>
              <div className={styles.list}>
                {devices.map((device) => (
                  <button
                    aria-pressed={device.deviceId === value.deviceId}
                    className={cx(styles.row, device.deviceId === value.deviceId && styles.active)}
                    disabled={locked || !device.online}
                    key={device.deviceId}
                    type="button"
                    onClick={() => changeDevice(device.deviceId)}
                  >
                    <span className={styles.deviceIcon}>
                      <ExecutionTargetIcon devicePlatform={device.platform} target="device" />
                    </span>
                    <Flexbox flex={1} style={{ minWidth: 0 }}>
                      <span className={styles.name}>
                        {device.friendlyName || device.hostname || device.deviceId}
                      </span>
                      <span className={styles.description}>
                        <ExecutionTargetDeviceStatus
                          offlineLabel={t('offline')}
                          online={device.online}
                          onlineLabel={t('environment.online')}
                        />
                      </span>
                    </Flexbox>
                    {device.deviceId === value.deviceId && <Icon icon={CheckIcon} size={14} />}
                  </button>
                ))}
              </div>
            </Flexbox>
          }
          onOpenChange={setDeviceOpen}
        >
          <button
            aria-label={t('selectDevice')}
            className={styles.chip}
            disabled={locked}
            type="button"
          >
            <ExecutionTargetIcon
              devicePlatform={selectedDevice?.platform}
              target={localDevice ? 'local' : 'device'}
            />
            <span className={styles.chipLabel}>
              {selectedDevice?.friendlyName ||
                selectedDevice?.hostname ||
                value.deviceId ||
                t('selectDevice')}
            </span>
            <Icon icon={ChevronDownIcon} size={12} />
          </button>
        </Popover>
        <Popover
          open={directoryOpen && !locked}
          placement="bottomLeft"
          styles={{ content: { padding: 4 } }}
          trigger="click"
          content={
            <Flexbox className={styles.menu} gap={4}>
              {directories.length >= 8 && (
                <Input
                  autoFocus
                  placeholder={deviceT('workingDirectory.searchPlaceholder')}
                  prefix={<Icon icon={SearchIcon} size={14} />}
                  size="small"
                  value={search}
                  variant="borderless"
                  onChange={(event) => setSearch(event.target.value)}
                />
              )}
              <div className={styles.section}>{deviceT('workingDirectory.recent')}</div>
              <div className={styles.list}>
                {filtered.length === 0 && (
                  <div className={styles.section}>
                    {deviceT(
                      search.trim() ? 'workingDirectory.noMatch' : 'workingDirectory.noRecent',
                    )}
                  </div>
                )}
                {filtered.map((entry) => (
                  <button
                    aria-pressed={entry.path === value.workingDirectory}
                    disabled={locked}
                    key={entry.path}
                    title={entry.path}
                    type="button"
                    className={cx(
                      styles.row,
                      entry.path === value.workingDirectory && styles.active,
                    )}
                    onClick={() => pickDirectory(entry.path)}
                  >
                    <DirIcon repoType={entry.repoType} />
                    <Flexbox flex={1} style={{ minWidth: 0 }}>
                      <span className={styles.name}>{getWorkingDirectoryName(entry.path)}</span>
                      <span className={styles.description}>{entry.path}</span>
                    </Flexbox>
                    {entry.path === value.workingDirectory && (
                      <Icon icon={CheckIcon} size={16} style={{ color: cssVar.colorSuccess }} />
                    )}
                  </button>
                ))}
              </div>
              <button
                className={styles.row}
                disabled={locked}
                type="button"
                onClick={localDevice ? browse : addRemoteDirectory}
              >
                <Icon icon={localDevice ? FolderOpenIcon : FolderPlusIcon} size={14} />
                <span className={styles.name}>
                  {deviceT(
                    localDevice
                      ? 'workingDirectory.chooseDifferentFolder'
                      : 'workingDirectory.addFolder',
                  )}
                </span>
              </button>
            </Flexbox>
          }
          onOpenChange={(open) => {
            setDirectoryOpen(open);
            setSearch('');
          }}
        >
          <button
            aria-label={t('directory')}
            className={styles.chip}
            disabled={locked || !value.deviceId}
            title={value.workingDirectory}
            type="button"
          >
            <DirIcon
              repoType={
                directories.find((entry) => entry.path === value.workingDirectory)?.repoType
              }
            />
            <span className={styles.chipLabel}>
              {getWorkingDirectoryName(value.workingDirectory) || t('directory')}
            </span>
            <Icon icon={ChevronDownIcon} size={12} />
          </button>
        </Popover>
      </Flexbox>
      {(error || hint !== null) && (
        <Text type={error ? 'danger' : 'secondary'}>
          {error || hint || t('environment.fullPathHint')}
        </Text>
      )}
    </Flexbox>
  );
}
