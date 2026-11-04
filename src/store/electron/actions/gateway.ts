import { isDesktop } from '@lobechat/const';
import type { GatewayConnectionState } from '@lobechat/electron-client-ipc';
import { toast } from '@lobehub/ui';
import { t } from 'i18next';
import { type SWRResponse } from 'swr';
import useSWR from 'swr';

import { GATEWAY_ERROR_MESSAGE_KEYS } from '@/helpers/gatewayConnection';
import { electronKeys } from '@/libs/swr/keys';
import { gatewayConnectionService } from '@/services/electron/gatewayConnection';
import { getDeviceStoreState } from '@/store/device/store';
import { type StoreSetter } from '@/store/types';

import { type ElectronStore } from '../store';

type Setter = StoreSetter<ElectronStore>;
export const gatewaySlice = (set: Setter, get: () => ElectronStore, _api?: unknown) =>
  new ElectronGatewayActionImpl(set, get, _api);

export interface GatewayDeviceInfo {
  deviceId: string;
  hostname: string;
  platform: string;
}

export class ElectronGatewayActionImpl {
  readonly #get: () => ElectronStore;
  readonly #set: Setter;
  #connectAttempt = 0;

  constructor(set: Setter, get: () => ElectronStore, _api?: unknown) {
    void _api;
    this.#get = get;
    this.#set = set;
  }

  connectGateway = async (): Promise<void> => {
    if (this.#get().gatewayReconnectPending) return;
    const attempt = ++this.#connectAttempt;
    this.#set({
      gatewayConnectionError: undefined,
      gatewayConnectionStatus: 'connecting',
      gatewayReconnectPending: true,
    });
    try {
      await gatewayConnectionService.connect();
      // IPC success only means the attempt started. Authentication and the
      // main process' retries decide when every surface can report recovery.
      if (attempt === this.#connectAttempt && this.#get().gatewayReconnectPending) {
        const state = await gatewayConnectionService.getConnectionStatus();
        if (attempt === this.#connectAttempt && this.#get().gatewayReconnectPending)
          this.setGatewayConnectionState(state);
      }
    } catch (error) {
      if (attempt !== this.#connectAttempt || !this.#get().gatewayReconnectPending) return;
      console.error('Gateway connect failed:', error);
      this.setGatewayConnectionState({
        status: 'disconnected',
        error: { code: 'config_unavailable' },
      });
    }
  };

  disconnectGateway = async (): Promise<void> => {
    this.#connectAttempt++;
    this.#set({ gatewayReconnectPending: false });
    try {
      await gatewayConnectionService.disconnect();
      this.#set({
        gatewayConnectionError: undefined,
        gatewayConnectionStatus: 'disconnected',
        gatewayReconnectPending: false,
      });
      void getDeviceStoreState().refreshDevices().catch(console.error);
    } catch (error) {
      console.error('Gateway disconnect failed:', error);
    }
  };

  setGatewayConnectionState = ({ error, status }: GatewayConnectionState): void => {
    const previous = this.#get();
    const settled = status === 'connected' || status === 'disconnected';
    const pending = previous.gatewayReconnectPending;
    const presenceChanged =
      previous.gatewayConnectionStatus !== status &&
      (status === 'connected' || previous.gatewayConnectionStatus === 'connected');
    this.#set(
      {
        gatewayConnectionError: error,
        gatewayConnectionStatus: status,
        gatewayReconnectPending: pending && !settled,
      },
      false,
      'setGatewayConnectionState',
    );
    if (presenceChanged) void getDeviceStoreState().refreshDevices().catch(console.error);
    if (!pending || !settled) return;
    if (status === 'connected') toast.success(t('gateway.reconnected', { ns: 'electron' }));
    else
      toast.error(
        t(error ? GATEWAY_ERROR_MESSAGE_KEYS[error.code] : 'gateway.statusDisconnected', {
          ns: 'electron',
        }),
      );
  };

  /**
   * This desktop's stable device id, for writes that pin a topic's cwd to it.
   *
   * Asked over IPC every time rather than read from `gatewayDeviceInfo`: before
   * the gateway connects, that holds the install's fallback UUID, which stops
   * naming this machine once the user-scoped identity is derived. The IPC
   * derives that identity locally — no network on the send path — and returns
   * nothing while signed out, so no pin is written rather than a stale one.
   * A differing cached id is corrected too, so "this device" comparisons agree
   * with the pins written here.
   */
  resolveGatewayDeviceId = async (): Promise<string | undefined> => {
    if (!isDesktop) return;
    try {
      const deviceId = (await gatewayConnectionService.getStableDeviceId()) ?? undefined;
      const cached = this.#get().gatewayDeviceInfo;
      if (deviceId && cached && cached.deviceId !== deviceId) {
        this.#set({ gatewayDeviceInfo: { ...cached, deviceId } }, false, 'setGatewayDeviceInfo');
      }
      return deviceId;
    } catch (error) {
      console.error('Gateway device id lookup failed:', error);
      return;
    }
  };

  useFetchGatewayDeviceInfo = (): SWRResponse<GatewayDeviceInfo> => {
    return useSWR<GatewayDeviceInfo>(
      // Desktop-only IPC: on web there is no electronAPI, so never fetch off-desktop.
      isDesktop ? electronKeys.gatewayDeviceInfo() : null,
      async () => gatewayConnectionService.getDeviceInfo() as Promise<GatewayDeviceInfo>,
      {
        onSuccess: (data) => {
          this.#set({ gatewayDeviceInfo: data }, false, 'setGatewayDeviceInfo');
        },
      },
    );
  };

  useFetchGatewayStatus = (): SWRResponse<GatewayConnectionState> => {
    return useSWR<GatewayConnectionState>(
      isDesktop ? 'electron:getGatewayConnectionStatus' : null,
      async () => gatewayConnectionService.getConnectionStatus(),
      { onSuccess: (data) => this.setGatewayConnectionState(data) },
    );
  };
}

export type ElectronGatewayAction = Pick<
  ElectronGatewayActionImpl,
  keyof ElectronGatewayActionImpl
>;
