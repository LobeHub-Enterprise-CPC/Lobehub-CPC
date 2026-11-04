import { Button, Tooltip } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { getGatewayConnectionView } from '@/helpers/gatewayConnection';
import { useElectronStore } from '@/store/electron';

const styles = stylex.create({
  tooltipTrigger: { display: 'inline-flex' },
});

interface GatewayReconnectButtonProps {
  /** The first status read has landed, so the store's initial `disconnected` is not an outage. */
  statusLoaded: boolean;
}

/**
 * Title-bar recovery for builds that keep the device gateway always on and so
 * show no gateway entry. It only appears once this desktop's connection has
 * failed or is recovering. Login and configuration failures stay visible too;
 * only an authenticated connection clears the warning.
 */
const GatewayReconnectButton = memo<GatewayReconnectButtonProps>(({ statusLoaded }) => {
  const { t } = useTranslation('electron');
  const status = useElectronStore((s) => s.gatewayConnectionStatus);
  const failure = useElectronStore((s) => s.gatewayConnectionError);
  const connectGateway = useElectronStore((s) => s.connectGateway);
  const pending = useElectronStore((s) => s.gatewayReconnectPending);
  const setConnectionDrawerOpen = useElectronStore((s) => s.setConnectionDrawerOpen);
  const view = getGatewayConnectionView(status, failure, pending);
  const needsLogin = !view.isConnecting && failure?.code === 'not_signed_in';
  const disabled = !view.isConnecting && !view.canReconnect && !needsLogin;
  const label = view.isConnecting
    ? 'gateway.reconnecting'
    : needsLogin
      ? 'gateway.signIn'
      : view.canReconnect
        ? 'gateway.reconnect'
        : 'gateway.unavailable';

  if (!statusLoaded || !view.isUnavailable) return null;

  return (
    <Tooltip placement={'bottomRight'} title={t(view.messageKey)}>
      <span tabIndex={disabled ? 0 : undefined} {...stylex.props(styles.tooltipTrigger)}>
        <Button
          danger
          disabled={disabled}
          icon={view.canReconnect || view.isConnecting ? RefreshCwIcon : TriangleAlertIcon}
          loading={view.isConnecting}
          size={'small'}
          onClick={() => (needsLogin ? setConnectionDrawerOpen(true) : void connectGateway())}
        >
          {t(label)}
        </Button>
      </span>
    </Tooltip>
  );
});

GatewayReconnectButton.displayName = 'GatewayReconnectButton';

export default GatewayReconnectButton;
