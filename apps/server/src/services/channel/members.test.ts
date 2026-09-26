// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { resolveChannelMembers } from './members';

const { getAgent, constructor } = vi.hoisted(() => ({ getAgent: vi.fn(), constructor: vi.fn() }));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    constructor(...args: unknown[]) {
      constructor(...args);
    }
    getAgentConfigById = getAgent;
  },
}));

const db = {} as LobeChatDatabase;
beforeEach(() => vi.clearAllMocks());
describe('Existing Channel Agent references', () => {
  it.each(['amp', 'grok-build'])('preserves the %s identity, device and role', async (runtime) => {
    getAgent.mockResolvedValue({
      id: 'local-agent',
      name: runtime,
      systemRole: 'Challenge assumptions',
      agencyConfig: {
        executionTarget: 'device',
        boundDeviceId: 'device',
        heterogeneousProvider: { type: runtime, systemContext: 'Be concise' },
      },
    });
    const [member] = await resolveChannelMembers(db, 'owner', [
      { agentId: 'local-agent', deviceId: 'device', workingDirectory: '/repo' },
    ]);
    expect(member.config).toMatchObject({
      runtime,
      systemRole: 'Challenge assumptions\n\nBe concise',
      deviceId: 'device',
    });
    await expect(
      resolveChannelMembers(db, 'owner', [{ agentId: 'local-agent', deviceId: 'other' }]),
    ).rejects.toThrow('already bound');
  });
  it('reads the owned Agent identity/model instead of creating or overriding one', async () => {
    getAgent.mockResolvedValue({
      id: 'agent-a',
      name: 'Ada',
      title: 'Reviewer',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      avatar: 'A',
      systemRole: 'Be precise',
    });
    const [member] = await resolveChannelMembers(db, 'owner', [{ agentId: 'agent-a' }]);
    expect(constructor).toHaveBeenCalledWith(db, 'owner');
    expect(member).toMatchObject({
      name: 'Ada',
      config: {
        agentId: 'agent-a',
        runtime: 'native',
        avatar: 'A',
        model: 'deepseek-v4-flash',
        systemRole: 'Be precise',
      },
    });
  });
  it('uses the existing Codex provider and its default model rather than a Native default', async () => {
    getAgent.mockResolvedValue({
      id: 'codex-a',
      title: 'Codex',
      model: 'unrelated-native-model',
      agencyConfig: { heterogeneousProvider: { type: 'codex', command: 'codex' } },
    });
    const [member] = await resolveChannelMembers(db, 'owner', [
      { agentId: 'codex-a', deviceId: 'device', workingDirectory: '/repo' },
    ]);
    expect(member.config).toMatchObject({
      agentId: 'codex-a',
      runtime: 'codex',
      model: '',
      deviceId: 'device',
    });
  });
  it('rejects missing, virtual, duplicate and unsupported Agent configurations', async () => {
    getAgent.mockResolvedValue(null);
    await expect(resolveChannelMembers(db, 'owner', [{ agentId: 'other' }])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      resolveChannelMembers(db, 'owner', [{ agentId: 'a' }, { agentId: 'a' }]),
    ).rejects.toThrow('already selected');
    getAgent.mockResolvedValue({ id: 'a', virtual: true });
    await expect(resolveChannelMembers(db, 'owner', [{ agentId: 'a' }])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    getAgent.mockResolvedValue({
      id: 'a',
      agencyConfig: { heterogeneousProvider: { type: 'claude-code' } },
    });
    await expect(resolveChannelMembers(db, 'owner', [{ agentId: 'a' }])).rejects.toThrow(
      'not supported',
    );
    getAgent.mockResolvedValue({
      id: 'a',
      agencyConfig: { heterogeneousProvider: { type: 'codex', args: ['--unsafe'] } },
    });
    await expect(resolveChannelMembers(db, 'owner', [{ agentId: 'a' }])).rejects.toThrow(
      'settings',
    );
  });
});
