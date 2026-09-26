// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelDevice } from './device';

const { findDevice, execute, update } = vi.hoisted(() => ({
  findDevice: vi.fn(),
  execute: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/database/models/device', () => ({
  DeviceModel: class {
    findByDeviceId = findDevice;
    update = update;
  },
}));
vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: { executeToolCall: execute },
  isPathWithinRoot: (root: string, path: string) => path === root || path.startsWith(`${root}/`),
}));
const adapter = new ChannelDevice({} as LobeChatDatabase, 'owner', 'device');
beforeEach(() => {
  vi.clearAllMocks();
  findDevice.mockResolvedValue({ workingDirs: [{ path: '/tmp/repo' }] });
  execute.mockResolvedValue({
    success: true,
    content: JSON.stringify({
      available: true,
      protocol: 'channel-v1',
      canonicalPath: '/private/tmp/repo',
    }),
  });
});
describe('Channel approved directory aliases', () => {
  it('accepts the canonical location of an explicitly selected root', async () => {
    await expect(adapter.probe('/tmp/repo')).resolves.toBe('/private/tmp/repo');
    expect(execute).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith('device', {
      workingDirs: [{ path: '/private/tmp/repo' }, { path: '/tmp/repo' }],
    });
  });
  it('rejects a nested symlink escaping the approved root', async () => {
    execute.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        available: true,
        protocol: 'channel-v1',
        canonicalPath: '/outside',
      }),
    });
    await expect(adapter.probe('/tmp/repo/link')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not probe an unapproved directory or another workspace device', async () => {
    await expect(adapter.probe('/outside')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
    findDevice.mockResolvedValue({
      workspaceId: 'workspace',
      workingDirs: [{ path: '/tmp/repo' }],
    });
    await expect(adapter.probe('/tmp/repo')).rejects.toThrow('Personal execution device');
    expect(execute).not.toHaveBeenCalled();
  });
});
