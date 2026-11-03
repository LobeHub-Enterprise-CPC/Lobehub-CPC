import { DESKTOP_DEVICE_GATEWAY_ALWAYS_ON } from '@lobechat/business-const';
import { useWatchBroadcast } from '@lobechat/electron-client-ipc';
import { ActionIcon, Button, createStaticStyles, Flexbox, Popover, Switch } from '@lobehub/ui';
import { HardDrive, RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import {
  getScopedConnectionCount,
  getWorkspaceConnectionState,
} from '@/features/DeviceManager/connectionCount';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useDeviceList } from '@/store/device';
import { useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';

import { GATEWAY_ERROR_MESSAGE_KEYS, isGatewayFailureRetryable } from './gatewayFailure';

const styles = createStaticStyles(({ css, cssVar }) => ({
  errorDot: css`
    position: absolute;
    inset-block-end: 0;
    inset-inline-end: 0;

    width: 8px;
    height: 8px;
    border: 1.5px solid ${cssVar.colorBgContainer};
    border-radius: 50%;

    background: ${cssVar.colorError};
  `,
  errorHint: css`
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorError};
  `,
  greenDot: css`
    position: absolute;
    inset-block-end: 0;
    inset-inline-end: 0;

    width: 8px;
    height: 8px;
    border: 1.5px solid ${cssVar.colorBgContainer};
    border-radius: 50%;

    background: #52c41a;
  `,
  popoverContent: css`
    width: 250px;
  `,
  scopeHint: css`
    font-size: 11px;
    line-height: 1.4;
    color: ${cssVar.colorTextDescription};
    white-space: nowrap;
  `,
  statusTitle: css`
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  warningDot: css`
    position: absolute;
    inset-block-end: 0;
    inset-inline-end: 0;

    width: 8px;
    height: 8px;
    border: 1.5px solid ${cssVar.colorBgContainer};
    border-radius: 50%;

    background: ${cssVar.colorWarning};
  `,
}));

interface DeviceGatewayProps {
  /**
   * The build keeps the connection on by itself (`DESKTOP_DEVICE_GATEWAY_ALWAYS_ON`):
   * the entry reports status and can reconnect, but offers no switch to turn
   * the connection off.
   */
  alwaysOn?: boolean;
  workspaceScoped: boolean;
}

/**
 * Loads the gateway status and this device's identity, and follows status
 * broadcasts. Many features read `gatewayDeviceInfo` to recognise the current
 * computer, and the composer's device hint reads the status, so the title-bar
 * entry runs this app-wide.
 */
const useGatewayStateSync = () => {
  const setGatewayConnectionState = useElectronStore((s) => s.setGatewayConnectionState);

  useElectronStore((s) => s.useFetchGatewayStatus)();
  useElectronStore((s) => s.useFetchGatewayDeviceInfo)();
  useWatchBroadcast('gatewayConnectionStatusChanged', setGatewayConnectionState);
};

const DeviceGateway = memo<DeviceGatewayProps>(({ alwaysOn = false, workspaceScoped }) => {
  const { t } = useTranslation('electron');
  const navigate = useWorkspaceAwareNavigate();
  const [gatewayStatus, gatewayError, connectGateway, disconnectGateway] = useElectronStore((s) => [
    s.gatewayConnectionStatus,
    s.gatewayConnectionError,
    s.connectGateway,
    s.disconnectGateway,
  ]);

  useGatewayStateSync();
  const gatewayDeviceInfo = useElectronStore((s) => s.gatewayDeviceInfo);
  const deviceList = useDeviceList();
  const devices = deviceList.data;

  const isConnected = gatewayStatus === 'connected';
  const isConnecting =
    gatewayStatus === 'authenticating' ||
    gatewayStatus === 'connecting' ||
    gatewayStatus === 'reconnecting';

  // Only the personal connection is toggled from here; workspace rows have their own status.
  const failure = !workspaceScoped && !isConnected && !isConnecting ? gatewayError : undefined;
  // Without a switch, a settled outage — or a reconnect loop that keeps
  // failing — is fixed from the reconnect button instead.
  const needsReconnect =
    alwaysOn &&
    !workspaceScoped &&
    (gatewayStatus === 'disconnected' || gatewayStatus === 'reconnecting');

  const [open, setOpen] = useState(false);

  const openDeviceSettings = () => {
    setOpen(false);
    navigate('/settings/devices');
  };

  const handleSwitchChange = useCallback(
    async (checked: boolean) => {
      if (checked) {
        await connectGateway();
      } else {
        await disconnectGateway();
      }
    },
    [connectGateway, disconnectGateway],
  );

  const connectionCount = getScopedConnectionCount(
    devices,
    workspaceScoped ? 'workspace' : 'personal',
    workspaceScoped ? undefined : gatewayDeviceInfo?.deviceId,
  );
  const workspaceConnectionState = getWorkspaceConnectionState(deviceList);
  const scopeConnected = workspaceScoped ? workspaceConnectionState === 'connected' : isConnected;
  const connectionHint = workspaceScoped
    ? workspaceConnectionState === 'unavailable'
      ? t('gateway.workspaceStatusUnavailable')
      : workspaceConnectionState === 'connecting'
        ? t('gateway.statusConnecting')
        : workspaceConnectionState === 'connected'
          ? t('gateway.workspaceStatusConnections', { count: connectionCount })
          : t('gateway.workspaceStatusDisconnected')
    : isConnecting
      ? t('gateway.statusConnecting')
      : isConnected && connectionCount
        ? t('gateway.statusConnectedConnections', { count: connectionCount })
        : t(isConnected ? 'gateway.statusConnected' : 'gateway.statusDisconnected');

  const popoverContent = (
    <Flexbox className={styles.popoverContent} gap={4}>
      <Flexbox horizontal align="center" justify="space-between">
        <span className={styles.statusTitle}>{t('gateway.title')}</span>
        <Flexbox horizontal align="center" gap={6}>
          <ActionIcon
            aria-label={t('gateway.manageDevices')}
            icon={SettingsIcon}
            size="small"
            title={t('gateway.manageDevices')}
            onClick={openDeviceSettings}
          />
          {!workspaceScoped && !alwaysOn && (
            <Switch
              aria-label={t('gateway.enableConnection')}
              checked={isConnected || isConnecting}
              loading={isConnecting}
              size="small"
              onChange={handleSwitchChange}
            />
          )}
        </Flexbox>
      </Flexbox>
      <span className={styles.scopeHint}>{connectionHint}</span>
      {failure && (
        <Flexbox align="flex-start" gap={4}>
          <span className={styles.errorHint} title={failure.detail}>
            {t(GATEWAY_ERROR_MESSAGE_KEYS[failure.code])}
          </span>
          {!alwaysOn && isGatewayFailureRetryable(failure.code) && (
            <Flexbox horizontal gap={4}>
              <Button outdent size="small" type="text" onClick={() => void connectGateway()}>
                {t('gateway.retry')}
              </Button>
            </Flexbox>
          )}
        </Flexbox>
      )}
      {needsReconnect && isGatewayFailureRetryable(failure?.code) && (
        <Flexbox horizontal>
          <Button
            icon={RefreshCwIcon}
            size="small"
            type="primary"
            onClick={() => void connectGateway()}
          >
            {t('gateway.reconnect')}
          </Button>
        </Flexbox>
      )}
    </Flexbox>
  );

  return (
    <Popover
      arrow={false}
      content={popoverContent}
      open={open}
      placement="bottomRight"
      styles={{ content: { padding: 8 } }}
      trigger="click"
      onOpenChange={setOpen}
    >
      <div style={{ position: 'relative' }}>
        <ActionIcon
          icon={HardDrive}
          loading={isConnecting}
          size="small"
          title={t('gateway.title')}
          tooltipProps={{ placement: 'bottomRight' }}
        />
        {scopeConnected ? (
          <div className={styles.greenDot} />
        ) : failure ? (
          <div className={styles.errorDot} />
        ) : (
          needsReconnect && <div className={styles.warningDot} />
        )}
      </div>
    </Popover>
  );
});

const DeviceGatewayWithAuth = memo(() => {
  const isSyncActive = useElectronStore(electronSyncSelectors.isSyncActive);
  const activeWorkspaceSlug = useActiveWorkspaceSlug();

  if (!isSyncActive) return null;

  return (
    <DeviceGateway
      alwaysOn={DESKTOP_DEVICE_GATEWAY_ALWAYS_ON}
      workspaceScoped={!!activeWorkspaceSlug}
    />
  );
});

export default DeviceGatewayWithAuth;
