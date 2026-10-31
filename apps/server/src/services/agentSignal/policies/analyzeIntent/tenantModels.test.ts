// @vitest-environment node
import { DEFAULT_MINI_SYSTEM_AGENT_ITEM } from '@lobechat/const';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackDomainJudgeAgentService } from './feedbackDomainAgent';
import { FeedbackSatisfactionJudgeAgentService } from './feedbackSatisfaction';
import { SkillIntentClassifierAgentService } from './skillIntent';

const mocks = vi.hoisted(() => ({
  defaultModel: undefined as { model: string; provider: string } | undefined,
  generateObject: vi.fn(),
  initRuntime: vi.fn(),
}));
vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: mocks.initRuntime }));
vi.mock('@/server/globalConfig/systemModels', () => ({
  getServerSystemModels: vi.fn(async () => ({ defaultModel: mocks.defaultModel })),
}));

afterEach(() => vi.clearAllMocks());

describe('Agent Signal tenant model routing', () => {
  const cases = [
    [
      'satisfaction',
      (config: { model?: string; provider?: string }) =>
        new FeedbackSatisfactionJudgeAgentService({} as never, 'user', config).judgeSatisfaction({
          message: 'Fix that',
        }),
    ],
    [
      'domain',
      (config: { model?: string; provider?: string }) =>
        new FeedbackDomainJudgeAgentService({} as never, 'user', config).judgeDomains({
          message: 'Fix that',
          evidence: [],
          reason: 'correction',
          result: 'not_satisfied',
        }),
    ],
    [
      'skill',
      (config: { model?: string; provider?: string }) =>
        new SkillIntentClassifierAgentService({} as never, 'user', config).classify({
          message: 'Fix that',
        } as never),
    ],
  ] as const;
  describe.each(cases)('%s', (_, run) => {
    it.each(['tenant', 'explicit', 'code'] as const)(
      'uses the %s model at the runtime boundary',
      async (mode) => {
        mocks.defaultModel =
          mode === 'code' ? undefined : { model: 'tenant-classifier', provider: 'lobehub' };
        const config = mode === 'explicit' ? { model: 'judge', provider: 'openai' } : {};
        const expected =
          mode === 'explicit' ? config : (mocks.defaultModel ?? DEFAULT_MINI_SYSTEM_AGENT_ITEM);
        const boundary = new Error('runtime boundary');
        mocks.generateObject.mockRejectedValue(boundary);
        mocks.initRuntime.mockResolvedValue({ generateObject: mocks.generateObject });
        await expect(run(config)).rejects.toBe(boundary);
        expect(mocks.initRuntime).toHaveBeenCalledWith(
          expect.anything(),
          'user',
          expected.provider,
          undefined,
        );
        expect(mocks.generateObject).toHaveBeenCalledWith(
          expect.objectContaining({ model: expected.model }),
          expect.anything(),
        );
      },
    );
  });
});
