import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGatewayMuxWarmup } from './useGatewayMuxWarmup';

const mock = vi.hoisted(() => ({ ready: true, protocol: 2, warmup: vi.fn() }));
vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (value: unknown) => unknown) =>
    selector({ warmupGatewayMux: mock.warmup }),
}));
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (value: unknown) => unknown) =>
    selector({ isUserStateInit: mock.ready, isSignedIn: mock.ready }),
}));
vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (value: unknown) => unknown) =>
    selector({
      serverConfig: { agentGatewayProtocol: mock.protocol },
      featureFlags: { enableGatewayMux: false },
    }),
}));

beforeEach(() => {
  mock.ready = true;
  mock.protocol = 2;
  mock.warmup.mockClear();
});
describe('useGatewayMuxWarmup', () => {
  it('warms protocol 2 despite a stale false flag', () => {
    const { unmount } = renderHook(useGatewayMuxWarmup);
    expect(mock.warmup).toHaveBeenCalledOnce();
    unmount();
  });
  it('waits for sign-in and for protocol 2 configuration', () => {
    mock.ready = false;
    mock.protocol = 1;
    const { rerender, unmount } = renderHook(useGatewayMuxWarmup);
    expect(mock.warmup).not.toHaveBeenCalled();
    mock.ready = true;
    rerender();
    expect(mock.warmup).not.toHaveBeenCalled();
    mock.protocol = 2;
    rerender();
    expect(mock.warmup).toHaveBeenCalledOnce();
    unmount();
  });
});
