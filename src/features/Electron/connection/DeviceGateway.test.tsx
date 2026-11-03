import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceGateway from './DeviceGateway';

const flags = vi.hoisted(() => ({ alwaysOn: false }));
const state = vi.hoisted(() => ({
  connectGateway: vi.fn(),
  disconnectGateway: vi.fn(),
  gatewayConnectionError: undefined,
  gatewayConnectionStatus: 'connected',
  gatewayDeviceInfo: { deviceId: 'dev_local' },
  setGatewayConnectionState: vi.fn(),
  syncActive: true,
  useFetchGatewayDeviceInfo: vi.fn(),
  useFetchGatewayStatus: vi.fn(),
}));
const watchBroadcast = vi.hoisted(() => vi.fn());

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get DESKTOP_DEVICE_GATEWAY_ALWAYS_ON() {
    return flags.alwaysOn;
  },
}));

vi.mock('@lobechat/electron-client-ipc', () => ({ useWatchBroadcast: watchBroadcast }));

vi.mock('@/store/electron', () => ({
  useElectronStore: <T,>(selector: (s: typeof state) => T) => selector(state),
}));

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
  state.connectGateway.mockClear();
  state.useFetchGatewayStatus.mockClear();
  state.useFetchGatewayDeviceInfo.mockClear();
  watchBroadcast.mockClear();
});

afterEach(cleanup);

const openEntry = () => {
  const trigger = screen
    .getAllByRole('button')
    .find((el) => el.getAttribute('aria-haspopup') === 'dialog');
  fireEvent.click(trigger!);
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

  it('shows a status entry without the off switch when the gateway is always on', async () => {
    flags.alwaysOn = true;

    render(<DeviceGateway />);
    openEntry();

    expect(await screen.findByText('gateway.title')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText('gateway.reconnect')).not.toBeInTheDocument();
    expect(state.useFetchGatewayStatus).toHaveBeenCalled();
    expect(state.useFetchGatewayDeviceInfo).toHaveBeenCalled();
    expect(watchBroadcast).toHaveBeenCalledWith(
      'gatewayConnectionStatusChanged',
      state.setGatewayConnectionState,
    );
  });

  it('offers a reconnect when an always-on gateway has dropped', async () => {
    flags.alwaysOn = true;
    state.gatewayConnectionStatus = 'disconnected';

    render(<DeviceGateway />);
    openEntry();
    fireEvent.click(await screen.findByText('gateway.reconnect'));

    expect(state.connectGateway).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('does not offer a reconnect that needs a sign-in first', async () => {
    flags.alwaysOn = true;
    state.gatewayConnectionStatus = 'disconnected';
    (state as { gatewayConnectionError: unknown }).gatewayConnectionError = {
      code: 'not_signed_in',
    };

    render(<DeviceGateway />);
    openEntry();

    expect(await screen.findByText('gateway.error.notSignedIn')).toBeInTheDocument();
    expect(screen.queryByText('gateway.reconnect')).not.toBeInTheDocument();
  });

  it('renders nothing before sync is active', () => {
    flags.alwaysOn = true;
    state.syncActive = false;

    const { container } = render(<DeviceGateway />);

    expect(container).toBeEmptyDOMElement();
    expect(state.useFetchGatewayDeviceInfo).not.toHaveBeenCalled();
  });
});
