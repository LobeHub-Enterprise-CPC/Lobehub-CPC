import { DEFAULT_SYSTEM_AGENT_CONFIG } from '@lobechat/const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSystemAgentModelConfig } from './modelConfig';

const mocks = vi.hoisted(() => ({
  systemAgent: {} as Record<string, { model: string; provider: string }>,
}));

vi.mock('@/server/globalConfig/systemModels', () => ({
  getServerSystemModels: vi.fn(async () => ({ filesConfig: {}, systemAgent: mocks.systemAgent })),
}));

describe('resolveSystemAgentModelConfig', () => {
  beforeEach(() => {
    mocks.systemAgent = {};
  });

  describe('priority', () => {
    beforeEach(() => {
      mocks.systemAgent = { topic: { model: 'tenant-topic', provider: 'lobehub' } };
    });

    it("prefers the user's setting over the deployment system agent", async () => {
      await expect(
        resolveSystemAgentModelConfig({
          taskConfig: { model: 'user-topic', provider: 'openai' },
          taskKey: 'topic',
        }),
      ).resolves.toEqual({ model: 'user-topic', provider: 'openai' });
    });

    it('uses the deployment system agent when the user has no setting', async () => {
      await expect(resolveSystemAgentModelConfig({ taskKey: 'topic' })).resolves.toEqual({
        model: 'tenant-topic',
        provider: 'lobehub',
      });
    });

    it('falls back to the code default for slots the deployment leaves unset', async () => {
      await expect(resolveSystemAgentModelConfig({ taskKey: 'translation' })).resolves.toEqual({
        model: DEFAULT_SYSTEM_AGENT_CONFIG.translation.model,
        provider: DEFAULT_SYSTEM_AGENT_CONFIG.translation.provider,
      });
    });

    it('lets an explicit override win over everything', async () => {
      await expect(
        resolveSystemAgentModelConfig({
          override: { model: 'judge', provider: 'anthropic' },
          taskConfig: { model: 'user-topic', provider: 'openai' },
          taskKey: 'topic',
        }),
      ).resolves.toEqual({ model: 'judge', provider: 'anthropic' });
    });
  });

  it('should keep a configured LobeHub chat model', async () => {
    const result = await resolveSystemAgentModelConfig({
      taskConfig: {
        model: 'deepseek-v4-pro',
        provider: 'lobehub',
      },
      taskKey: 'topic',
    });

    expect(result).toEqual({ model: 'deepseek-v4-pro', provider: 'lobehub' });
  });

  it('should let runtime hooks resolve LobeHub model mapping', async () => {
    const result = await resolveSystemAgentModelConfig({
      taskConfig: {
        model: 'mapped-topic-model',
        provider: 'lobehub',
      },
      taskKey: 'topic',
    });

    expect(result).toEqual({ model: 'mapped-topic-model', provider: 'lobehub' });
  });

  it('should keep deprecated LobeHub model ids for runtime-level rejection', async () => {
    const result = await resolveSystemAgentModelConfig({
      taskConfig: {
        model: 'ag/gemini-3.1-pro-high',
        provider: 'lobehub',
      },
      taskKey: 'topic',
    });

    expect(result).toEqual({ model: 'ag/gemini-3.1-pro-high', provider: 'lobehub' });
  });

  it('should keep non-LobeHub provider model ids untouched', async () => {
    const result = await resolveSystemAgentModelConfig({
      taskConfig: {
        model: 'private-model',
        provider: 'openai-compatible',
      },
      taskKey: 'topic',
    });

    expect(result).toEqual({ model: 'private-model', provider: 'openai-compatible' });
  });
});
