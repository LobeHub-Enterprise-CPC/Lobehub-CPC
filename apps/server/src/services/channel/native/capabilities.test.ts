// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

import { loadChannelNativeCapabilities } from './capabilities';

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  settings: vi.fn(),
  redis: vi.fn(),
  queue: vi.fn(),
}));
vi.mock('@/server/services/agent', () => ({
  AgentService: class {
    getAgentConfig = mocks.agent;
  },
}));
vi.mock('@/database/models/user', () => ({
  UserModel: class {
    getUserSettings = mocks.settings;
  },
}));
vi.mock('@/server/modules/AgentRuntime/redis', () => ({ getAgentRuntimeRedisClient: mocks.redis }));
vi.mock('@/server/services/queue/impls', () => ({ isQueueAgentRuntimeEnabled: mocks.queue }));
const config = { agentId: 'agent', runtime: 'native', model: 'old', provider: 'old' } as any;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('QSTASH_TOKEN', 'fixture');
  mocks.queue.mockReturnValue(true);
  mocks.redis.mockReturnValue({});
  mocks.agent.mockResolvedValue({ model: 'current', provider: 'provider' });
  mocks.settings.mockResolvedValue({});
});
it('uses the original Agent identity for availability', async () => {
  await loadChannelNativeCapabilities({} as any, 'owner', config);
  expect(mocks.agent).toHaveBeenCalledWith('agent');
});
it('requires an existing native Agent', async () => {
  await expect(
    loadChannelNativeCapabilities({} as any, 'owner', { ...config, agentId: undefined }),
  ).rejects.toThrow('existing Agent');
  mocks.agent.mockResolvedValue(null);
  await expect(loadChannelNativeCapabilities({} as any, 'owner', config)).rejects.toThrow(
    'accessible',
  );
});
it('rejects a changed runtime', async () => {
  mocks.agent.mockResolvedValue({ agencyConfig: { heterogeneousProvider: { type: 'codex' } } });
  await expect(loadChannelNativeCapabilities({} as any, 'owner', config)).rejects.toThrow(
    'runtime has changed',
  );
});
it('does not fall back to an in-memory scheduler', async () => {
  mocks.queue.mockReturnValue(false);
  await expect(loadChannelNativeCapabilities({} as any, 'owner', config)).rejects.toThrow(
    'Redis/QStash',
  );
});
it('preserves user approvals instead of forcing headless execution', async () => {
  mocks.settings.mockResolvedValue({
    tool: { humanIntervention: { approvalMode: 'manual', allowList: ['read'] } },
  });
  expect(await loadChannelNativeCapabilities({} as any, 'owner', config)).toEqual({
    userInterventionConfig: { approvalMode: 'manual', allowList: ['read'] },
  });
});
