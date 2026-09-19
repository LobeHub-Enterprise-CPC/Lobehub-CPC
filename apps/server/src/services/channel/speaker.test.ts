// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelModel } from '@/database/models/channel';

import { routeChannelMessage } from './router';
import type { ChannelSpeakerInput } from './speaker';
import { channelRuleAudience, evaluateChannelAudience } from './speaker';

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock('ai', () => ({ experimental_evaluate: evaluate }));

const input: ChannelSpeakerInput = {
  members: ['frontend', 'backend', 'security'].map((id) => ({
    id,
    name: id,
    description: `${id} expert`,
    config: {
      model: 'test',
      provider: 'test',
      runtime: 'native',
      systemRole: id,
      deviceId: 'private-device',
    },
  })),
  message: { content: '请继续你刚才的分析', mentions: [], fileIds: [] },
  recent: [{ id: 'previous', authorName: 'backend', content: '事务锁等待是主要原因' }],
};

function answer(scope = 'single', probability = 0.96, speaker = 'member_1') {
  return {
    answers: {
      scope: { type: 'choice', choice: scope, probabilities: { [scope]: probability } },
      speaker: { type: 'choice', choice: speaker, probabilities: { [speaker]: 0.98 } },
      member_0: { type: 'boolean', probability: 0.8 },
      member_1: { type: 'boolean', probability: 0.2 },
      member_2: { type: 'boolean', probability: 0.99 },
    },
    usage: { inputTokens: 1234, outputTokens: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-only');
  evaluate.mockResolvedValue(answer());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Channel speaker policy', () => {
  it('compares the baseline with a single speaker even when other independent questions say yes', async () => {
    expect(channelRuleAudience(input)).toEqual(['frontend', 'backend', 'security']);
    const result = await evaluateChannelAudience(input);
    expect(result.memberIds).toEqual(['backend']);
    expect(result.diagnostics.source).toBe('jev');
    const request = evaluate.mock.calls[0][0];
    expect(request.state.history).toEqual(input.recent);
    expect(request.state.currentRequest).toBe(input.message.content);
    expect(request.state.members[1]).toMatchObject({ key: 'member_1', role: 'backend' });
    expect(JSON.stringify(request)).not.toContain('private-device');
    expect(request).toMatchObject({
      maxRetries: 0,
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
  });

  it('permits retention only by explicit caller opt-in, without changing subsequent defaults', async () => {
    await evaluateChannelAudience(input, { zeroDataRetention: false });
    expect(evaluate.mock.calls[0][0].providerOptions.gateway.zeroDataRetention).toBe(false);
    await evaluateChannelAudience(input);
    expect(evaluate.mock.calls[1][0].providerOptions.gateway.zeroDataRetention).toBe(true);
  });

  it.each([403, 429])('does not broadcast or disable ZDR after HTTP %s', async (statusCode) => {
    evaluate.mockRejectedValue(
      Object.assign(new Error('private provider response'), { statusCode }),
    );
    const result = await evaluateChannelAudience(input);
    expect(result.memberIds).toEqual([]);
    expect(result.noReply).toBe(false);
    expect(result.diagnostics).toMatchObject({
      source: 'fallback',
      errorStatus: statusCode,
      zeroDataRetention: true,
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0][0].providerOptions.gateway.zeroDataRetention).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private provider response');
  });

  it.each([
    ['all', ['frontend', 'backend', 'security']],
    ['none', []],
    ['subset', ['frontend', 'security']],
  ])(
    'handles %s without confusing independent Boolean probabilities with a distribution',
    async (scope, expected) => {
      evaluate.mockResolvedValue(answer(scope as string));
      const result = await evaluateChannelAudience(input);
      expect(result.memberIds).toEqual(expected);
      expect(result.noReply).toBe(scope === 'none');
    },
  );

  it('respects explicit mentions without sending any context to the provider', async () => {
    const result = await evaluateChannelAudience({
      ...input,
      message: { ...input.message, mentions: ['security'] },
    });
    expect(result.memberIds).toEqual(['security']);
    expect(result.diagnostics.source).toBe('rules');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    'uncertain-scope',
    'uncertain-speaker',
    'uncertain-subset',
    'empty-subset',
    'unknown-speaker',
  ])('leaves the request unassigned instead of broadcasting on %s', async (kind) => {
    const response = answer();
    if (kind === 'uncertain-scope') response.answers.scope.probabilities.single = 0.799;
    if (kind === 'uncertain-speaker') response.answers.speaker.probabilities.member_1 = 0.7;
    if (kind === 'unknown-speaker') response.answers.speaker.choice = 'not-a-member';
    if (kind.includes('subset')) {
      response.answers.scope = {
        type: 'choice',
        choice: 'subset',
        probabilities: { subset: 0.95 },
      };
      response.answers.member_0.probability = kind === 'empty-subset' ? 0.01 : 0.799;
      response.answers.member_1.probability = 0.1;
      response.answers.member_2.probability = 0.1;
    }
    evaluate.mockResolvedValue(response);
    const result = await evaluateChannelAudience(input);
    expect(result.memberIds).toEqual([]);
    expect(result.noReply).toBe(false);
    expect(result.diagnostics.source).toBe('fallback');
  });

  it('routes attachment messages using text without pretending to have read the files', async () => {
    const result = await evaluateChannelAudience({
      ...input,
      message: { ...input.message, fileIds: ['private-image-id'] },
    });
    expect(result.memberIds).toEqual(['backend']);
    expect(evaluate.mock.calls[0][0].state.attachmentCount).toBe(1);
    expect(JSON.stringify(evaluate.mock.calls[0][0])).not.toContain('private-image-id');
  });

  it('does not call the provider without a key or for empty candidates or oversized context', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const missing = await evaluateChannelAudience(input);
    expect(missing.reason).toContain('missing Gateway key');
    expect(missing.memberIds).toEqual([]);
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-only');
    expect((await evaluateChannelAudience({ ...input, members: [] })).memberIds).toEqual([]);
    expect(
      (
        await evaluateChannelAudience({
          ...input,
          message: { ...input.message, content: '字'.repeat(24_001) },
        })
      ).reason,
    ).toContain('too large');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('bounds the request deadline and never logs provider bodies on failure', async () => {
    vi.useFakeTimers();
    evaluate.mockImplementation(
      ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error('private response body')));
        }),
    );
    // Stub only the platform timeout; real HTTP cancellation uses this same signal.
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const pending = evaluateChannelAudience(input);
    controller.abort();
    const result = await pending;
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(result.memberIds).toEqual([]);
    expect(result.diagnostics.source).toBe('fallback');
    expect(JSON.stringify(result)).not.toContain('private response body');
    timeout.mockRestore();
  });

  it('routes pending messages through Jev even if the obsolete broadcast flag remains set', async () => {
    const model = {
      routingInput: vi.fn().mockResolvedValue({ ...input, attemptId: 'attempt' }),
      assign: vi.fn(),
    };
    vi.stubEnv('CHANNEL_ROUTER', 'rules');
    await routeChannelMessage(model as unknown as ChannelModel, 'channel', 'message');
    expect(model.assign).toHaveBeenLastCalledWith(
      'channel',
      'message',
      expect.objectContaining({ memberIds: ['backend'] }),
      'attempt',
    );
    expect(evaluate).toHaveBeenCalledOnce();
    model.routingInput.mockResolvedValue(null);
    await routeChannelMessage(model as unknown as ChannelModel, 'channel', 'message');
    expect(model.assign).toHaveBeenCalledOnce();
  });
});
