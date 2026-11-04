import { toast } from '@lobehub/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayConnectionService } from '@/services/electron/gatewayConnection';
import { getDeviceStoreState } from '@/store/device/store';
import type { ElectronStore } from '@/store/electron/store';

import { ElectronGatewayActionImpl } from './gateway';

vi.mock('@/services/electron/gatewayConnection', () => ({
  gatewayConnectionService: { connect: vi.fn(), disconnect: vi.fn(), getConnectionStatus: vi.fn() },
}));
vi.mock('@/store/device/store', () => ({ getDeviceStoreState: vi.fn() }));
vi.mock('@lobehub/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('i18next', () => ({ t: (key: string) => key }));

const refreshDevices = vi.fn().mockResolvedValue(undefined);
let state: ElectronStore;
let actions: ElectronGatewayActionImpl;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDeviceStoreState).mockReturnValue({ refreshDevices } as never);
  state = {
    gatewayConnectionStatus: 'disconnected',
    gatewayReconnectPending: false,
  } as ElectronStore;
  actions = new ElectronGatewayActionImpl(
    (patch: object) => Object.assign(state, patch),
    () => state,
  );
});

describe('shared gateway recovery', () => {
  it('does not report a failure or revive an old attempt after the user turns the device off', async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(gatewayConnectionService.connect).mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    vi.mocked(gatewayConnectionService.disconnect).mockImplementation(async () => {
      actions.setGatewayConnectionState({ status: 'disconnected' });
      return { success: true };
    });
    const attempt = actions.connectGateway();
    await actions.disconnectGateway();
    reject(new Error('late IPC failure'));
    await attempt;
    expect(state.gatewayConnectionStatus).toBe('disconnected');
    expect(state.gatewayReconnectPending).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('keeps an accepted IPC connect pending until authentication actually succeeds', async () => {
    vi.mocked(gatewayConnectionService.connect).mockResolvedValue({ success: true });
    vi.mocked(gatewayConnectionService.getConnectionStatus).mockResolvedValue({
      status: 'authenticating',
    });
    await actions.connectGateway();
    expect(state.gatewayReconnectPending).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    actions.setGatewayConnectionState({ status: 'connected' });
    actions.setGatewayConnectionState({ status: 'connected' });
    expect(state.gatewayReconnectPending).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(refreshDevices).toHaveBeenCalledTimes(1);
  });

  it('joins a reconnect started from the other surface instead of starting a second IPC connect', async () => {
    vi.mocked(gatewayConnectionService.connect).mockResolvedValue({ success: true });
    vi.mocked(gatewayConnectionService.getConnectionStatus).mockResolvedValue({
      status: 'reconnecting',
    });
    await actions.connectGateway();
    await actions.connectGateway();
    expect(gatewayConnectionService.connect).toHaveBeenCalledTimes(1);
    expect(state.gatewayReconnectPending).toBe(true);
  });

  it('reports a terminal failure once and allows a later retry', async () => {
    vi.mocked(gatewayConnectionService.connect).mockResolvedValue({ success: false });
    vi.mocked(gatewayConnectionService.getConnectionStatus).mockResolvedValue({
      status: 'disconnected',
      error: { code: 'auth_failed' },
    });
    await actions.connectGateway();
    actions.setGatewayConnectionState({ status: 'disconnected', error: { code: 'auth_failed' } });
    expect(state.gatewayReconnectPending).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('refreshes server presence on an automatic recovery without announcing a manual reconnect', () => {
    state.gatewayConnectionStatus = 'reconnecting';
    actions.setGatewayConnectionState({ status: 'connected' });
    expect(refreshDevices).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
