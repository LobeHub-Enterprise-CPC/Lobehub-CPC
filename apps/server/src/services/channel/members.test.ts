// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { resolveChannelMemberRuntime, resolveChannelMembers } from './members';

const { getAgent, getConfiguredAgent, constructor } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getConfiguredAgent: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    constructor(...args: unknown[]) {
      constructor(...args);
    }
    getAgentConfigById = getAgent;
  },
}));
vi.mock('@/server/services/agent', () => ({
  AgentService: class {
    getAgentConfigById = getConfiguredAgent;
  },
}));

const db = {} as LobeChatDatabase;
beforeEach(() => {
  vi.clearAllMocks();
  getConfiguredAgent.mockImplementation(() => getAgent());
});
describe('Existing Channel Agent references', () => {
  it.each(['codex', 'amp', 'grok-build', 'claude-code', 'pi'] as const)(
    'preserves the %s standalone context without injecting its hidden native role',
    async (runtime) => {
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
        systemRole: 'Be concise',
        deviceId: 'device',
      });
      await expect(
        resolveChannelMemberRuntime(db, 'owner', 'local-agent', runtime),
      ).resolves.toMatchObject({ systemRole: 'Be concise' });
      await expect(
        resolveChannelMembers(db, 'owner', [
          { agentId: 'local-agent', deviceId: 'other', workingDirectory: '/another-project' },
        ]),
      ).resolves.toMatchObject([
        { config: { deviceId: 'other', workingDirectory: '/another-project', runtime } },
      ]);
      expect((await getAgent()).agencyConfig.boundDeviceId).toBe('device');
      await expect(
        resolveChannelMemberRuntime(db, 'owner', 'local-agent', 'native'),
      ).rejects.toThrow('runtime has changed');
    },
  );
  it.each(['codex', 'amp', 'grok-build', 'claude-code', 'pi'] as const)(
    'does not fall back to a hidden role when %s has no system context',
    async (runtime) => {
      getAgent.mockResolvedValue({
        id: 'agent-a',
        systemRole: 'Hidden test-only persona',
        agencyConfig: { heterogeneousProvider: { type: runtime } },
      });
      const [member] = await resolveChannelMembers(db, 'owner', [{ agentId: 'agent-a' }]);
      expect(member.config.systemRole).toBe('');
      await expect(
        resolveChannelMemberRuntime(db, 'owner', 'agent-a', runtime),
      ).resolves.toMatchObject({ systemRole: '' });
    },
  );
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
    await expect(
      resolveChannelMemberRuntime(db, 'owner', 'agent-a', 'native'),
    ).resolves.toMatchObject({ systemRole: 'Be precise' });
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
  it('accepts private provider settings without persisting them in membership', async () => {
    getAgent.mockResolvedValue({
      id: 'codex-a',
      agencyConfig: {
        heterogeneousProvider: {
          type: 'codex',
          args: ['--profile', 'work'],
          env: { API_SECRET: 'never-persist-me' },
          authMode: 'api',
          effort: 'high',
          speed: 'fast',
        },
      },
    });
    const [member] = await resolveChannelMembers(db, 'owner', [
      { agentId: 'codex-a', deviceId: 'device', workingDirectory: '/repo' },
    ]);
    expect(member.config).toMatchObject({ agentId: 'codex-a', runtime: 'codex' });
    expect(JSON.stringify(member)).not.toContain('never-persist-me');
    expect(member.config).not.toHaveProperty('args');
    expect(member.config).not.toHaveProperty('env');
  });
  it.each(['inbox', 'custom-agent'])(
    'resolves sparse %s config with standalone defaults',
    async (slug) => {
      getAgent.mockResolvedValue({
        id: 'inbox-agent',
        slug,
        virtual: slug === 'inbox',
        model: null,
        provider: null,
      });
      getConfiguredAgent.mockResolvedValue({
        title: 'Lobe AI',
        model: 'deepseek-v4-flash',
        provider: 'deepseek',
        systemRole: 'My configured prompt',
      });
      await expect(
        resolveChannelMembers(db, 'owner', [{ agentId: 'inbox-agent' }]),
      ).resolves.toMatchObject([
        {
          name: 'Lobe AI',
          config: {
            agentId: 'inbox-agent',
            runtime: 'native',
            model: 'deepseek-v4-flash',
            provider: 'deepseek',
            systemRole: 'My configured prompt',
          },
        },
      ]);
      await expect(
        resolveChannelMemberRuntime(db, 'owner', 'inbox-agent', 'native'),
      ).resolves.toEqual({
        provider: undefined,
        systemRole: 'My configured prompt',
      });
      expect(getConfiguredAgent).toHaveBeenCalledWith('inbox-agent');
    },
  );

  it('rejects missing, internal virtual, duplicate and unsupported Agent configurations', async () => {
    getAgent.mockResolvedValue(null);
    await expect(resolveChannelMembers(db, 'owner', [{ agentId: 'other' }])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      resolveChannelMembers(db, 'owner', [{ agentId: 'a' }, { agentId: 'a' }]),
    ).rejects.toThrow('already selected');
    getAgent.mockResolvedValue({ id: 'a', slug: 'page-copilot', virtual: true });
    await expect(resolveChannelMembers(db, 'owner', [{ agentId: 'a' }])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(resolveChannelMemberRuntime(db, 'owner', 'a', 'native')).rejects.toThrow(
      'no longer accessible',
    );
    getAgent.mockResolvedValue({
      id: 'a',
      agencyConfig: { heterogeneousProvider: { type: 'cursor' } },
    });
    await expect(resolveChannelMembers(db, 'owner', [{ agentId: 'a' }])).rejects.toThrow(
      'not supported',
    );
  });
});
