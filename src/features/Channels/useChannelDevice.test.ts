import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceService } from '@/services/device';

import { useChannelDevice } from './useChannelDevice';

vi.mock('@/services/device', () => ({ deviceService: { listDevices: vi.fn() } }));

const boundA = { heteroType: 'codex', boundDeviceId: 'device-a' };
const boundB = { heteroType: 'codex', boundDeviceId: 'device-b' };
const unbound = { heteroType: 'codex' };
const devices = [
  { deviceId: 'device-a', friendlyName: 'Desktop A', defaultCwd: '/work/alpha', online: true },
  { deviceId: 'device-b', friendlyName: 'Desktop B', defaultCwd: '/work/beta', online: true },
] as Awaited<ReturnType<typeof deviceService.listDevices>>;

function setup(
  agents: Parameters<typeof useChannelDevice>[0],
  existing?: Parameters<typeof useChannelDevice>[1],
) {
  const cache = new Map();
  return renderHook((selected) => useChannelDevice(selected, existing), {
    initialProps: agents,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => cache } }, children),
  });
}

describe('Channel device selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deviceService.listDevices).mockResolvedValue(devices);
  });

  it('does not require or fetch devices for Native-only members', () => {
    const { result } = setup([{}]);
    expect(result.current).toMatchObject({ needsDevice: false, ready: true, deviceId: '' });
    expect(deviceService.listDevices).not.toHaveBeenCalled();
  });

  it('uses one shared binding for bound and unbound members, after devices load', async () => {
    const { result } = setup([boundA, { ...boundA }, unbound]);
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toMatchObject({
      fixedDeviceId: 'device-a',
      deviceId: 'device-a',
      directory: '/work/alpha',
      deviceConflict: false,
    });
    act(() => result.current.setDirectory('/work/review'));
    expect(result.current.directory).toBe('/work/review');
  });

  it('blocks conflicting bindings and recovers when a member is removed', async () => {
    const { result, rerender } = setup([boundA, boundB]);
    expect(result.current).toMatchObject({ deviceConflict: true, ready: false });
    rerender([boundB]);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toMatchObject({
      deviceConflict: false,
      deviceId: 'device-b',
      directory: '/work/beta',
    });
  });

  it('allows manual selection only without a binding and keeps edited directories device-scoped', async () => {
    const { result, rerender } = setup([unbound]);
    await waitFor(() => expect(result.current.devices).toHaveLength(2));
    expect(result.current).toMatchObject({ fixedDeviceId: undefined, ready: false });
    act(() => result.current.setDeviceId('device-b'));
    act(() => result.current.setDirectory('/work/custom-beta'));
    rerender([unbound, boundA]);
    expect(result.current).toMatchObject({ deviceId: 'device-a', directory: '/work/alpha' });
    rerender([unbound]);
    expect(result.current).toMatchObject({ deviceId: 'device-b', directory: '/work/custom-beta' });
    act(() => result.current.setDirectory(''));
    expect(result.current).toMatchObject({ directory: '', ready: false });
  });

  it.each(['offline', 'missing'])(
    'does not replace an %s bound device with an online one',
    async (state) => {
      vi.mocked(deviceService.listDevices).mockResolvedValue(
        state === 'missing' ? [devices[1]] : [{ ...devices[0], online: false }, devices[1]],
      );
      const { result } = setup([boundA]);
      await waitFor(() => expect(result.current.devices).toBeDefined());
      expect(result.current).toMatchObject({
        fixedDeviceId: 'device-a',
        deviceId: 'device-a',
        ready: false,
      });
    },
  );

  it('preserves an existing Channel device and directory when adding members', async () => {
    const { result, rerender } = setup([boundA], {
      deviceId: 'device-b',
      workingDirectory: '/work/channel',
    });
    expect(result.current).toMatchObject({ deviceConflict: true, ready: false });
    rerender([boundB]);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toMatchObject({ deviceId: 'device-b', directory: '/work/channel' });
  });
});
