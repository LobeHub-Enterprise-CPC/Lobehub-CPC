import type { GatewayConnectionStatus } from '@lobechat/electron-client-ipc';
import type { DeviceExecutionTarget, DeviceListItem } from '@lobechat/types';

/**
 * Whether the machine the next run executes on can be reached, as the
 * composer reports it.
 *
 * - `ok` — nothing to report: the device is connected, the run does not go
 *   through a device, or the facts are not known yet.
 * - `local` — the run executes on this desktop through the device gateway,
 *   and this desktop's gateway connection is down. It can reconnect here.
 * - `remote` — the run executes on another machine that the server sees
 *   offline (or no longer lists). Only that machine can reconnect it, so the
 *   person picks another device.
 */
export type ExecutionDeviceHealth =
  | { kind: 'ok' }
  | { kind: 'local'; reconnecting: boolean }
  | { device?: DeviceListItem; kind: 'remote' };

export interface ResolveExecutionDeviceHealthParams {
  boundDeviceId?: string;
  /** This desktop's own device id; `undefined` on web or before it is known. */
  currentDeviceId?: string;
  /** Device rows the picker can choose from; `undefined` while not loaded. */
  devices?: DeviceListItem[];
  /** The server confirmed `devices`, so a missing row means the device is gone. */
  devicesConfirmed: boolean;
  executionTarget: DeviceExecutionTarget;
  /** This desktop's gateway status; `undefined` until the first read lands. */
  gatewayStatus?: GatewayConnectionStatus;
  isDesktop: boolean;
  /**
   * A `local` run goes through the device gateway: gateway mode is on and the
   * agent is not a local CLI that the desktop spawns in-process.
   */
  localRunsThroughGateway: boolean;
}

const OK: ExecutionDeviceHealth = { kind: 'ok' };

const localHealth = (status: GatewayConnectionStatus | undefined): ExecutionDeviceHealth => {
  // `connecting` / `authenticating` are an attempt in flight (start-up, a
  // sign-in or a click on reconnect); the main process already holds a short
  // drop on `connected`, so only a settled outage reaches the composer.
  if (status === 'disconnected') return { kind: 'local', reconnecting: false };
  if (status === 'reconnecting') return { kind: 'local', reconnecting: true };
  return OK;
};

export const resolveExecutionDeviceHealth = ({
  boundDeviceId,
  currentDeviceId,
  devices,
  devicesConfirmed,
  executionTarget,
  gatewayStatus,
  isDesktop,
  localRunsThroughGateway,
}: ResolveExecutionDeviceHealthParams): ExecutionDeviceHealth => {
  if (executionTarget === 'local') {
    if (!isDesktop || !localRunsThroughGateway) return OK;
    return localHealth(gatewayStatus);
  }

  if (executionTarget !== 'device' || !boundDeviceId) return OK;

  // Bound to this very desktop: its own connection decides, and it can
  // reconnect from here.
  if (isDesktop && currentDeviceId && boundDeviceId === currentDeviceId)
    return localHealth(gatewayStatus);

  const device = devices?.find((item) => item.deviceId === boundDeviceId);
  if (!device) return devicesConfirmed ? { kind: 'remote' } : OK;
  // A row restored from the stored list has not been checked yet.
  if (device.online || device.onlineUnknown) return OK;
  return { device, kind: 'remote' };
};
