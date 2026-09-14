// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelDevice } from './device';

const { findDevice, execute, update } = vi.hoisted(() => ({
  findDevice: vi.fn(),
  execute: vi.fn(),
  update: vi.fn(),
}));
const { beginBinding, getAgent } = vi.hoisted(() => ({
  beginBinding: vi.fn(),
  getAgent: vi.fn(),
}));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    getAgentConfigById = getAgent;
  },
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
vi.mock('./serverDefault', () => ({ beginChannelServerDefaultOperation: beginBinding }));
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
  getAgent.mockResolvedValue({
    id: 'agent',
    systemRole: 'Fresh role',
    agencyConfig: {
      executionTarget: 'device',
      boundDeviceId: 'device',
      heterogeneousProvider: {
        type: 'codex',
        env: { TOKEN: 'fresh-secret' },
        systemContext: 'Fresh context',
      },
    },
  });
  beginBinding.mockResolvedValue(undefined);
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
  it('resolves fresh provider configuration for probe and start', async () => {
    await adapter.probe('/tmp/repo', 'codex', 'agent');
    expect(JSON.parse(execute.mock.calls[0][1].arguments)).toMatchObject({
      runtime: 'codex',
      provider: { type: 'codex', env: { TOKEN: 'fresh-secret' } },
    });
    await adapter.start(
      {
        cwd: '/tmp/repo',
        fence: 1,
        manifest: {} as never,
        model: '',
        runId: 'run',
        runtime: 'codex',
      },
      'agent',
    );
    expect(JSON.parse(execute.mock.calls[1][1].arguments)).toMatchObject({
      provider: { env: { TOKEN: 'fresh-secret' } },
      systemRole: 'Fresh context',
    });
  });
  it('forwards only the ephemeral server-default binding returned for the fresh Agent', async () => {
    const provider = {
      type: 'codex',
      authMode: 'api',
      apiConfig: { source: 'server-default', model: 'gpt-5.4' },
    };
    getAgent.mockResolvedValueOnce({
      id: 'agent',
      agencyConfig: { heterogeneousProvider: provider },
    });
    beginBinding.mockResolvedValueOnce({ model: 'lobehub-default', token: 'ephemeral' });
    await adapter.start(
      {
        cwd: '/tmp/repo',
        fence: 2,
        manifest: {} as never,
        model: '',
        runId: 'run-api',
        runtime: 'codex',
      },
      'agent',
    );
    expect(beginBinding).toHaveBeenCalledWith({
      agentId: 'agent',
      db: expect.anything(),
      ownerId: 'owner',
      provider,
      runId: 'run-api',
      runtime: 'codex',
    });
    expect(JSON.parse(execute.mock.calls[0][1].arguments)).toMatchObject({
      serverDefaultBinding: { model: 'lobehub-default', token: 'ephemeral' },
    });
  });
  it('rejects a changed runtime but keeps the Channel device independent of the Agent binding', async () => {
    await expect(adapter.probe('/tmp/repo', 'amp', 'agent')).rejects.toThrow('runtime has changed');
    expect(execute).not.toHaveBeenCalled();
    getAgent.mockResolvedValueOnce({
      id: 'agent',
      agencyConfig: {
        executionTarget: 'device',
        boundDeviceId: 'other',
        heterogeneousProvider: { type: 'codex', env: { TOKEN: 'do-not-leak' } },
      },
    });
    await expect(adapter.probe('/tmp/repo', 'codex', 'agent')).resolves.toBe('/private/tmp/repo');
    expect(execute.mock.calls[0][0]).toEqual({ userId: 'owner', deviceId: 'device' });
  });

  it('marks failures before dispatch as definitely unsubmitted, including a created operation', async () => {
    beginBinding.mockResolvedValueOnce({ model: 'lobehub-default', token: 'ephemeral' });
    findDevice.mockResolvedValueOnce(undefined);
    await expect(
      adapter.start(
        { cwd: '/tmp/repo', fence: 1, manifest: {} as never, model: '', runId: 'run' },
        'agent',
      ),
    ).rejects.toMatchObject({
      submission: 'not-submitted',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('marks an error after invoking the gateway as having unknown acceptance', async () => {
    execute.mockRejectedValueOnce(new Error('ack lost'));
    await expect(
      adapter.start({ cwd: '/tmp/repo', fence: 1, manifest: {} as never, model: '', runId: 'run' }),
    ).rejects.toMatchObject({ submission: 'unknown' });
    expect(execute).toHaveBeenCalledOnce();
  });
});
