import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceGateway from './DeviceGateway';

const flags = vi.hoisted(() => ({ alwaysOn: false }));
const state = vi.hoisted(() => ({
  connectGateway: vi.fn(),
  disconnectGateway: vi.fn(),
  gatewayConnectionError: undefined as { code: string; detail?: string } | undefined,
  gatewayConnectionStatus: 'connected',
  gatewayDeviceInfo: { deviceId: 'dev_local' },
  setGatewayConnectionState: vi.fn(),
  /** What the first status read returned; `undefined` until it lands. */
  statusRead: { status: 'connected' } as object | undefined,
  syncActive: true,
  useFetchGatewayDeviceInfo: vi.fn(),
  useFetchGatewayStatus: vi.fn(),
}));
const watchBroadcast = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast,
}));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get DESKTOP_DEVICE_GATEWAY_ALWAYS_ON() {
    return flags.alwaysOn;
  },
}));

vi.mock('@lobechat/electron-client-ipc', () => ({ useWatchBroadcast: watchBroadcast }));

// Subscribes like the real store, so a status change re-renders memoised readers.
const storeListeners = vi.hoisted(() => ({ set: new Set<() => void>(), version: 0 }));

vi.mock('@/store/electron', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    storeListeners.set.add(listener);
    return () => storeListeners.set.delete(listener);
  };
  return {
    useElectronStore: <T,>(selector: (s: typeof state) => T) => {
      useSyncExternalStore(subscribe, () => storeListeners.version);
      return selector(state);
    },
  };
});

vi.mock('@/store/electron/selectors', () => ({
  electronSyncSelectors: { isSyncActive: (s: typeof state) => s.syncActive },
}));

vi.mock('@/business/client/hooks/useActiveWorkspaceSlug', () => ({
  useActiveWorkspaceSlug: () => null,
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

vi.mock('@/store/device', () => ({ useDeviceList: () => ({ data: [] }) }));

beforeEach(() => {
  flags.alwaysOn = false;
  state.syncActive = true;
  state.gatewayConnectionError = undefined;
  state.gatewayConnectionStatus = 'connected';
  state.statusRead = { status: 'connected' };
  state.connectGateway.mockReset();
  state.useFetchGatewayStatus.mockReset();
  state.useFetchGatewayStatus.mockImplementation(() => ({ data: state.statusRead }));
  state.useFetchGatewayDeviceInfo.mockClear();
  watchBroadcast.mockClear();
  toast.error.mockClear();
  toast.success.mockClear();
});

afterEach(cleanup);

const reconnectButton = () => screen.queryByRole('button', { name: /gateway\.reconnect/ });

const dropTo = (status: string, error?: { code: string; detail?: string }) => {
  state.gatewayConnectionStatus = status;
  state.gatewayConnectionError = error;
  storeListeners.version += 1;
  storeListeners.set.forEach((listener) => listener());
};

describe('DeviceGateway', () => {
  it('shows the title-bar entry and loads gateway state when the gateway is user-controlled', () => {
    render(<DeviceGateway />);

    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    expect(state.useFetchGatewayStatus).toHaveBeenCalled();
    expect(state.useFetchGatewayDeviceInfo).toHaveBeenCalled();
    expect(watchBroadcast).toHaveBeenCalledWith(
      'gatewayConnectionStatusChanged',
      state.setGatewayConnectionState,
    );
  });

  it('hides the entry but still loads gateway state while an always-on gateway is healthy', () => {
    flags.alwaysOn = true;

    const { container } = render(<DeviceGateway />);

    expect(container).toBeEmptyDOMElement();
    expect(state.useFetchGatewayStatus).toHaveBeenCalled();
    expect(state.useFetchGatewayDeviceInfo).toHaveBeenCalled();
    expect(watchBroadcast).toHaveBeenCalledWith(
      'gatewayConnectionStatusChanged',
      state.setGatewayConnectionState,
    );
  });

  it('renders nothing before sync is active', () => {
    flags.alwaysOn = true;
    state.syncActive = false;

    const { container } = render(<DeviceGateway />);

    expect(container).toBeEmptyDOMElement();
    expect(state.useFetchGatewayDeviceInfo).not.toHaveBeenCalled();
  });

  describe('always-on reconnect button', () => {
    beforeEach(() => {
      flags.alwaysOn = true;
    });

    it.each([
      ['a rejected sign-in', 'disconnected', { code: 'auth_failed' }],
      ['an unreadable server config', 'disconnected', { code: 'config_unavailable' }],
      ['a drop without a reason', 'disconnected', undefined],
      ['a reconnect loop that keeps failing', 'reconnecting', undefined],
    ])('appears after %s', (_, status, error) => {
      dropTo(status, error);

      render(<DeviceGateway />);

      expect(reconnectButton()).toBeInTheDocument();
    });

    it.each([
      ['connecting', undefined],
      ['authenticating', undefined],
      ['disconnected', { code: 'not_signed_in' }],
      ['disconnected', { code: 'invalid_gateway_url' }],
    ])('keeps an unresolved connection visible while %s (%o)', (status, error) => {
      dropTo(status, error);

      const { container } = render(<DeviceGateway />);

      expect(container).not.toBeEmptyDOMElement();
    });

    it('stays on screen, busy, while the main process retries an outage on its own', () => {
      dropTo('reconnecting');
      render(<DeviceGateway />);

      act(() => dropTo('connecting'));

      expect(reconnectButton()).toBeInTheDocument();
      expect(reconnectButton()).toHaveAttribute('aria-busy', 'true');

      act(() => dropTo('connected'));

      expect(reconnectButton()).not.toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("does not read the store's initial `disconnected` as an outage", () => {
      dropTo('disconnected');
      state.statusRead = undefined;

      const { container } = render(<DeviceGateway />);

      expect(container).toBeEmptyDOMElement();
    });

    it('reconnects, stays busy while the attempt runs, and confirms the recovery', async () => {
      dropTo('disconnected', { code: 'auth_failed' });
      state.connectGateway.mockImplementation(async () => dropTo('connecting'));
      render(<DeviceGateway />);

      await act(async () => fireEvent.click(reconnectButton()!));

      expect(state.connectGateway).toHaveBeenCalledTimes(1);
      expect(reconnectButton()).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();

      act(() => dropTo('connected'));

      expect(reconnectButton()).not.toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('reports why a reconnect failed and keeps the button for another try', async () => {
      dropTo('disconnected');
      state.connectGateway.mockImplementation(async () =>
        dropTo('disconnected', { code: 'auth_failed' }),
      );
      render(<DeviceGateway />);

      await act(async () => fireEvent.click(reconnectButton()!));

      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(reconnectButton()).toBeInTheDocument();
    });
  });
});
