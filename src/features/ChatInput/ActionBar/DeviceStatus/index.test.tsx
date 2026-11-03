/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutionDeviceHealth } from '../../ControlBar/executionDeviceHealth';
import DeviceStatus from './index';

const state = vi.hoisted(() => ({
  agentMode: true,
  connectGateway: vi.fn(),
  gatewayConnectionError: undefined as { code: string; detail?: string } | undefined,
  gatewayConnectionStatus: 'disconnected',
  health: { kind: 'ok' } as ExecutionDeviceHealth,
}));
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: { success: toastSuccess },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));

vi.mock('../../hooks/useAgentId', () => ({ useAgentId: () => 'agt_1' }));

vi.mock('../../hooks/useEffectiveAgentMode', () => ({
  useEffectiveAgentMode: () => ({ isAgentRuntimeMode: state.agentMode }),
}));

vi.mock('../../ControlBar/useExecutionDeviceHealth', () => ({
  useExecutionDeviceHealth: () => state.health,
}));

vi.mock('@/store/electron', () => ({
  useElectronStore: <T,>(selector: (s: typeof state) => T) => selector(state),
}));

beforeEach(() => {
  state.agentMode = true;
  state.connectGateway.mockReset();
  state.gatewayConnectionError = undefined;
  state.gatewayConnectionStatus = 'disconnected';
  state.health = { kind: 'ok' };
  toastSuccess.mockClear();
});

afterEach(cleanup);

const hint = () => screen.queryByTestId('execution-device-hint');

describe('DeviceStatus', () => {
  it('renders nothing while the execution device is reachable', () => {
    render(<DeviceStatus />);

    expect(hint()).not.toBeInTheDocument();
  });

  it('renders nothing for a chat-only model', () => {
    state.agentMode = false;
    state.health = { kind: 'local', reconnecting: false };

    render(<DeviceStatus />);

    expect(hint()).not.toBeInTheDocument();
  });

  it('asks for another device when the remote one is offline', () => {
    state.health = {
      device: { deviceId: 'dev_remote', friendlyName: 'Studio Mac' } as never,
      kind: 'remote',
    };

    render(<DeviceStatus />);

    expect(hint()).toHaveAttribute('data-kind', 'remote');
    expect(hint()).toHaveAccessibleName(
      'heteroAgent.executionTarget.hint.remote.tooltip:Studio Mac',
    );
    expect(screen.getByText('heteroAgent.executionTarget.hint.remote.label')).toBeInTheDocument();
    expect(screen.queryByTestId('execution-device-reconnect')).not.toBeInTheDocument();
  });

  it('falls back to a generic hint when the device is no longer listed', () => {
    state.health = { kind: 'remote' };

    render(<DeviceStatus />);

    expect(hint()).toHaveAccessibleName('heteroAgent.executionTarget.hint.remote.tooltipUnknown');
  });

  it('reconnects this desktop from the local hint and confirms the recovery', async () => {
    state.health = { kind: 'local', reconnecting: false };
    let finish!: () => void;
    state.connectGateway.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    const view = render(<DeviceStatus />);
    expect(hint()).toHaveAttribute('data-kind', 'local');

    fireEvent.click(hint()!);
    fireEvent.click(await screen.findByTestId('execution-device-reconnect'));
    expect(state.connectGateway).toHaveBeenCalledTimes(1);

    // `connecting` alone reads as healthy; the hint stays while the attempt runs.
    state.health = { kind: 'ok' };
    state.gatewayConnectionStatus = 'connecting';
    view.rerender(<DeviceStatus />);
    expect(hint()).toBeInTheDocument();

    state.gatewayConnectionStatus = 'connected';
    await act(async () => finish());
    view.rerender(<DeviceStatus />);

    expect(hint()).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('heteroAgent.executionTarget.hint.local.reconnected');
  });

  it('explains a failure that a reconnect cannot fix', async () => {
    state.health = { kind: 'local', reconnecting: false };
    state.gatewayConnectionError = { code: 'not_signed_in' };

    render(<DeviceStatus />);
    fireEvent.click(hint()!);

    expect(await screen.findByText('gateway.error.notSignedIn')).toBeInTheDocument();
    expect(screen.queryByTestId('execution-device-reconnect')).not.toBeInTheDocument();
  });

  it('tells the person a dropped connection is already retrying', async () => {
    state.health = { kind: 'local', reconnecting: true };
    state.gatewayConnectionStatus = 'reconnecting';

    render(<DeviceStatus />);
    fireEvent.click(hint()!);

    expect(
      await screen.findByText('heteroAgent.executionTarget.hint.local.reconnectingDesc'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('execution-device-reconnect')).toBeInTheDocument();
  });
});
