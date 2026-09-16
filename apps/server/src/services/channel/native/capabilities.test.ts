// @vitest-environment node
import type { ChannelMemberConfig } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { checkChannelNativeAvailability } from './capabilities';

const agent = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/agent', () => ({
  AgentService: class {
    getAgentConfig = agent;
  },
}));

const db = {} as LobeChatDatabase;
beforeEach(() => {
  vi.clearAllMocks();
  agent.mockResolvedValue({ model: 'gpt', provider: 'openai' });
});

describe('checkChannelNativeAvailability', () => {
  it('returns the current Agent model rather than the membership snapshot', async () => {
    await expect(
      checkChannelNativeAvailability(db, 'owner', {
        agentId: 'agent',
        model: 'stale-model',
        provider: 'stale-provider',
        runtime: 'native',
      }),
    ).resolves.toEqual({ agentId: 'agent', model: 'gpt', provider: 'openai' });
    expect(agent).toHaveBeenCalledWith('agent');
  });

  const snapshot = { model: 'stale-model', provider: 'stale-provider', runtime: 'native' as const };
  it.each<[ChannelMemberConfig, string, unknown]>([
    [snapshot, 'must reference an existing Agent', undefined],
    [{ ...snapshot, agentId: 'agent' }, 'no longer accessible', null],
    [
      { ...snapshot, agentId: 'agent' },
      'runtime has changed',
      { agencyConfig: { heterogeneousProvider: 'codex' }, model: 'gpt', provider: 'openai' },
    ],
    [{ ...snapshot, agentId: 'agent' }, 'Configure a model', { model: 'gpt', provider: '' }],
  ])('rejects %j with %s', async (config, message, resolved) => {
    if (resolved !== undefined) agent.mockResolvedValue(resolved);
    await expect(checkChannelNativeAvailability(db, 'owner', config)).rejects.toThrow(message);
  });
});
