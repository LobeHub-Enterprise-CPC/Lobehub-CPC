import { powerMonitor } from 'electron';

import { resolveGatewayEnabled } from '@/const/store';

interface AutoConnectDeps {
  connect: () => Promise<unknown>;
  /** The persisted `gatewayEnabled` value. */
  gatewayEnabled: () => boolean | undefined;
  getAccessToken: () => Promise<string | null | undefined>;
  isRemoteServerConfigured: () => Promise<boolean>;
}

/** Connect the device when it is switched on and a login exists. */
export const tryGatewayAutoConnect = async (deps: AutoConnectDeps) => {
  if (!resolveGatewayEnabled(deps.gatewayEnabled())) return;
  if (!(await deps.isRemoteServerConfigured())) return;
  if (!(await deps.getAccessToken())) return;
  await deps.connect();
};

/**
 * After sleep the old socket can look open for minutes and a device that gave
 * up while offline has no client left: on wake or unlock, reconnect the live
 * connection now (`reconnectAfterWake`), or else connect the way start-up does.
 */
export const watchSystemWake = (reconnectAfterWake: () => boolean, autoConnect: () => unknown) => {
  const onWake = () => {
    if (!reconnectAfterWake()) void autoConnect();
  };
  powerMonitor.on('resume', onWake);
  powerMonitor.on('unlock-screen', onWake);
};
