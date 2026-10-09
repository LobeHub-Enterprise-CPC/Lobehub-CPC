import { ModelProvider } from 'model-bank';

import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import type { ChatStreamPayload } from '../../types';
import { createVolcengineImage } from './createImage';
import { createVolcengineVideo, pollVolcengineVideoStatus } from './video/createVideo';
import { handleVolcengineVideoWebhook } from './video/handleCreateVideoWebhook';

const isVolcengineReasoningEffortModel = (model: string) => {
  const normalizedModel = model.toLowerCase();

  return normalizedModel.includes('deepseek-v4') || normalizedModel.includes('glm-5-2');
};

/**
 * `thinking.type` values Ark accepts. The runtime's own union is wider — it also
 * carries `adaptive`, which is Anthropic's "let the model decide" and which Ark
 * rejects outright:
 *
 *     The parameter `type` specified in the request are not valid:
 *     invalid value adaptive.
 *
 * That reached here from a real caller, not a hypothetical one: `/api/v1/anthropic`
 * relays an Anthropic client's request body, and Claude Code sends
 * `thinking: {type: 'adaptive'}` on every request regardless of which model it
 * has been pointed at. Forwarding whatever arrived turned that into a 400 on
 * every turn.
 *
 * Anything outside this set is dropped rather than translated. Omitting the
 * field leaves Ark on the model's own default, which is what "let the model
 * decide" asks for — and unlike a guessed mapping it cannot fail the request.
 */
const ARK_THINKING_TYPES = new Set(['enabled', 'disabled']);

const arkThinking = (thinking: any) =>
  ARK_THINKING_TYPES.has(thinking?.type) ? thinking : undefined;

const resolveVolcengineReasoningParams = (
  model: string,
  thinking: any,
  reasoning_effort: any,
  isResponses = false,
) => {
  let targetThinking = arkThinking(thinking);
  let targetReasoningEffort = reasoning_effort;

  if (isVolcengineReasoningEffortModel(model)) {
    if (thinking?.type === 'disabled') {
      targetThinking = { type: 'disabled' };
      targetReasoningEffort = 'minimal';
    } else if (thinking?.type === 'enabled' || reasoning_effort) {
      targetThinking = { type: 'enabled' };
      let effort = reasoning_effort || 'high';
      if (isResponses && effort === 'max') {
        effort = 'high';
      }
      targetReasoningEffort = effort;
    }
  }

  return {
    thinking: targetThinking,
    reasoning_effort: targetReasoningEffort,
  };
};

export const LobeVolcengineAI = createOpenAICompatibleRuntime({
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  chatCompletion: {
    handlePayload: (payload) => {
      const { enabledSearch, thinking, reasoning_effort, ...rest } = payload;

      if (enabledSearch) {
        return {
          ...rest,
          apiMode: 'responses',
          enabledSearch,
        } as ChatStreamPayload;
      }

      const params = resolveVolcengineReasoningParams(
        payload.model,
        thinking,
        reasoning_effort,
        false,
      );

      return {
        ...rest,
        ...(params.thinking?.type && { thinking: { type: params.thinking.type } }),
        ...(params.reasoning_effort && { reasoning_effort: params.reasoning_effort }),
      } as any;
    },
  },
  createImage: createVolcengineImage,
  createVideo: createVolcengineVideo,
  debug: {
    chatCompletion: () => process.env.DEBUG_VOLCENGINE_CHAT_COMPLETION === '1',
    responses: () => process.env.DEBUG_VOLCENGINE_RESPONSES === '1',
  },
  handleCreateVideoWebhook: handleVolcengineVideoWebhook,
  handlePollVideoStatus: async (inferenceId, options) => {
    const baseURL = options.baseURL || 'https://ark.cn-beijing.volces.com/api/v3';
    return pollVolcengineVideoStatus(inferenceId, options.apiKey || '', baseURL);
  },
  provider: ModelProvider.Volcengine,
  responses: {
    handlePayload: (payload) => {
      const { enabledSearch, tools, thinking, reasoning_effort, ...rest } = payload;
      const params = resolveVolcengineReasoningParams(
        payload.model,
        thinking,
        reasoning_effort,
        true,
      );

      const volcengineTools = enabledSearch
        ? [
            ...(tools || []),
            {
              function: {
                sources: ['douyin', 'moji', 'toutiao'], // Additional search sources (Douyin Baike, Moji Weather, Toutiao, etc.)
              },
              type: 'web_search',
            },
          ]
        : tools;

      return {
        ...rest,
        tools: volcengineTools,
        ...(params.thinking?.type && { thinking: { type: params.thinking.type } }),
        ...(params.reasoning_effort && { reasoning_effort: params.reasoning_effort }),
      } as any;
    },
  },
  /**
   * Ark's `contents/generations/tasks` API has no callback parameter: a task is
   * submitted, then polled with `GET .../contents/generations/tasks/{id}` until it
   * reports `content.video_url` (see `createVideo.ts` and `handlePollVideoStatus`
   * above). Declaring `webhook` here strands every task on deployments without a
   * reachable callback endpoint — `createVideo` records the inferenceId and stops,
   * `schedulePolling` is never registered, and `handlePollVideoStatus` becomes
   * unreachable until the generic async-task watchdog reports
   * "task is timeout, please try again". This regression was introduced when a
   * canary sync added the declaration as a single new line; the CPC polling fix it
   * overrode is a5af22eea4 / 9c0fe84395.
   */
  videoGenerationCapabilities: { completionModes: ['polling'] },
});
