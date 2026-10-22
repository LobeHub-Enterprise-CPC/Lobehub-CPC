import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initModelRuntimeForRequest } from '../oneShot';
import {
  assertGatewayProviderCapability,
  resolveLlmExecutionSite,
} from '../resolveLlmExecutionSite';

const deps = vi.hoisted(() => ({
  config: undefined as { fetchOnClient: boolean } | undefined,
  server: vi.fn(),
  redis: vi.fn(),
  factory: vi.fn(),
}));
vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    getAiProviderById = async () => deps.config;
  },
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { getUserKeyVaults: vi.fn() },
}));
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: deps.server,
  resolveRuntimeProvider: (provider: string) => provider,
}));
vi.mock('@/server/modules/AgentRuntime/redis', () => ({ getAgentRuntimeRedisClient: deps.redis }));
vi.mock('@/server/modules/AgentRuntime/factory', () => ({
  createStreamEventManager: deps.factory,
}));

beforeEach(() => {
  vi.clearAllMocks();
  deps.config = undefined;
});
describe('closed LLM relay at application entries', () => {
  it('keeps a server-capable provider on the ordinary server runtime', async () => {
    deps.config = { fetchOnClient: false };
    deps.server.mockResolvedValue({ ordinary: true });
    await expect(initModelRuntimeForRequest({} as never, 'user', 'openai')).resolves.toEqual({
      ordinary: true,
    });
  });
  it('rejects a device-only request before allocating redis, gateway or fallback runtime', async () => {
    deps.config = { fetchOnClient: true };
    await expect(initModelRuntimeForRequest({} as never, 'user', 'ollama')).rejects.toMatchObject({
      code: 'LLM_RELAY_UNSUPPORTED',
      status: 501,
    });
    expect(deps.server).not.toHaveBeenCalled();
    expect(deps.redis).not.toHaveBeenCalled();
    expect(deps.factory).not.toHaveBeenCalled();
  });
  it('never selects the retained relay runtime for an agent run', async () => {
    deps.config = { fetchOnClient: true };
    await expect(
      resolveLlmExecutionSite({ db: {} as never, userId: 'user', provider: 'ollama' }),
    ).resolves.toEqual({ reason: 'relay_unsupported', site: 'unavailable' });
    await expect(
      assertGatewayProviderCapability({} as never, 'user', 'ollama'),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED', message: 'LLM_RELAY_UNSUPPORTED' });
  });
});
