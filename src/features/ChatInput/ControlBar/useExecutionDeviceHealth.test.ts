/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExecutionDeviceHealth } from './useExecutionDeviceHealth';

const state = vi.hoisted(() => ({
  agencyConfig: undefined as Record<string, unknown> | undefined,
  devices: [] as Record<string, unknown>[],
  fetchedGatewayState: undefined as unknown,
  gatewayConnectionStatus: 'disconnected',
  gatewayDeviceInfo: { deviceId: 'dev_local' },
  gatewayMode: true,
}));
const useDeviceList = vi.hoisted(() => vi.fn());

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDesktop: true,
}));

vi.mock('@/features/ChatInput/hooks/useChatInputResourceAccess', () => ({
  useChatInputResourceAccess: () => ({ canUseResource: true }),
}));

vi.mock('@/hooks/useEffectiveAgencyConfig', () => ({
  useEffectiveAgencyConfig: () => ({
    agencyConfig: state.agencyConfig,
    canDisplayExecutionTarget: true,
    isPreferenceLoading: false,
    topicDeviceUnknown: false,
    workspaceScoped: false,
  }),
}));

vi.mock('@/helpers/gatewayMode', () => ({ useIsGatewayModeEnabled: () => state.gatewayMode }));

vi.mock('@/store/device', () => ({ useDeviceList }));

vi.mock('@/store/electron', () => ({
  useElectronStore: <T>(
    selector: (s: {
      gatewayConnectionStatus: string;
      gatewayDeviceInfo: { deviceId: string };
      useFetchGatewayDeviceInfo: () => unknown;
      useFetchGatewayStatus: () => { data: unknown };
    }) => T,
  ) =>
    selector({
      gatewayConnectionStatus: state.gatewayConnectionStatus,
      gatewayDeviceInfo: state.gatewayDeviceInfo,
      useFetchGatewayDeviceInfo: () => ({}),
      useFetchGatewayStatus: () => ({ data: state.fetchedGatewayState }),
    }),
}));

vi.mock('../hooks/useTopicId', () => ({ useTopicId: () => undefined }));

beforeEach(() => {
  state.agencyConfig = { executionTarget: 'local' };
  state.devices = [];
  state.fetchedGatewayState = { status: 'disconnected' };
  state.gatewayConnectionStatus = 'disconnected';
  state.gatewayMode = true;
  useDeviceList.mockReset();
  useDeviceList.mockImplementation(() => ({ data: state.devices, isConfirmed: true }));
});

const health = () => renderHook(() => useExecutionDeviceHealth('agt_1')).result.current;

describe('useExecutionDeviceHealth', () => {
  it('reports this desktop when a gateway-mode Local run cannot reach it', () => {
    expect(health()).toEqual({ kind: 'local', reconnecting: false });
    expect(useDeviceList).toHaveBeenCalledWith({ refreshInterval: 0 });
  });

  it('ignores the store default until the first status read lands', () => {
    state.fetchedGatewayState = undefined;

    expect(health()).toEqual({ kind: 'ok' });
  });

  it('does not involve the gateway for a local CLI agent the desktop spawns', () => {
    state.agencyConfig = {
      executionTarget: 'local',
      heterogeneousProvider: { type: 'claude-code' },
    };

    expect(health()).toEqual({ kind: 'ok' });
  });

  it('keeps re-reading presence while the run targets a remote device', () => {
    const offline = {
      channels: [],
      deviceId: 'dev_remote',
      friendlyName: 'Studio Mac',
      online: false,
    };
    state.agencyConfig = { boundDeviceId: 'dev_remote', executionTarget: 'device' };
    state.devices = [offline];

    expect(health()).toEqual({ device: offline, kind: 'remote' });
    expect(useDeviceList).toHaveBeenCalledWith({ refreshInterval: 30_000 });
  });
});
