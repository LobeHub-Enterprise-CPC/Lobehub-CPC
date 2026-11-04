import { Button, toast, Tooltip } from '@lobehub/ui';
import { RefreshCwIcon } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useElectronStore } from '@/store/electron';

import { GATEWAY_ERROR_MESSAGE_KEYS, isGatewayFailureRetryable } from './gatewayFailure';

interface GatewayReconnectButtonProps {
  /** The first status read has landed, so the store's initial `disconnected` is not an outage. */
  statusLoaded: boolean;
}

/**
 * Title-bar recovery for builds that keep the device gateway always on and so
 * show no gateway entry. It only appears once this desktop's connection has
 * settled into an outage that connecting again can fix — the main process
 * already holds short drops on `connected` — and stays, busy, through every
 * attempt in between (its own or the main process' retries) until the
 * connection is back.
 */
const GatewayReconnectButton = memo<GatewayReconnectButtonProps>(({ statusLoaded }) => {
  const { t } = useTranslation('electron');
  const status = useElectronStore((s) => s.gatewayConnectionStatus);
  const failure = useElectronStore((s) => s.gatewayConnectionError);
  const connectGateway = useElectronStore((s) => s.connectGateway);

  /** The connect request is in flight. */
  const [pending, setPending] = useState(false);
  /** A reconnect started here has not settled yet. */
  const [attempting, setAttempting] = useState(false);
  /** The outage this button reports has not ended yet; retries in between keep it on screen. */
  const [down, setDown] = useState(false);

  const inFlight = status === 'connecting' || status === 'authenticating';
  const outage =
    (status === 'disconnected' || status === 'reconnecting') &&
    isGatewayFailureRetryable(failure?.code);
  const retrying = inFlight && (down || attempting);
  const busy = pending || retrying;

  useEffect(() => {
    if (outage) setDown(true);
    else if (!inFlight) setDown(false);
  }, [outage, inFlight]);

  const reason = failure
    ? t(GATEWAY_ERROR_MESSAGE_KEYS[failure.code])
    : t(status === 'reconnecting' ? 'gateway.statusConnecting' : 'gateway.statusDisconnected');

  // Report how the attempt started here ended. `reconnecting` means the main
  // process took over the retries, so the button simply comes back.
  useEffect(() => {
    if (!attempting || pending || inFlight) return;
    if (status === 'connected') toast.success(t('gateway.reconnected'));
    else if (status === 'disconnected') toast.error(reason);
    setAttempting(false);
  }, [attempting, pending, inFlight, status, reason, t]);

  const reconnect = async () => {
    setAttempting(true);
    setPending(true);
    try {
      await connectGateway();
    } finally {
      setPending(false);
    }
  };

  if (!statusLoaded || !(outage || busy)) return null;

  return (
    <Tooltip placement={'bottomRight'} title={busy ? t('gateway.statusConnecting') : reason}>
      <Button
        danger
        icon={RefreshCwIcon}
        loading={busy}
        size={'small'}
        onClick={() => void reconnect()}
      >
        {t('gateway.reconnect')}
      </Button>
    </Tooltip>
  );
});

GatewayReconnectButton.displayName = 'GatewayReconnectButton';

export default GatewayReconnectButton;
