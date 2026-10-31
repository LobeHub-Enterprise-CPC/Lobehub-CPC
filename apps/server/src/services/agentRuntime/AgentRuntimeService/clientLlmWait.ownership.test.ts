// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime/AgentRuntimeCoordinator';
import { formatErrorForState } from '@/server/modules/AgentRuntime/formatErrorForState';
import { createClientLlmExecutorUnavailableError } from '@/server/modules/AgentRuntime/llmRelay/errors';

import { parkForClientLlm, updateAssistantRowWithRetry } from './clientLlmWait';
import { StepOwnershipLostError } from './executionErrors';

const operationId = 'op-client-park-ownership';
const state = () => ({
  error: formatErrorForState(createClientLlmExecutorUnavailableError('lmstudio', 'no_executor')),
  host: {},
  metadata: {},
  modelRuntimeConfig: { model: 'qwen', provider: 'lmstudio' },
  origin: { topicId: 'topic' },
  status: 'error',
  stepCount: 2,
});

describe('client park write ownership', () => {
  it('does not overwrite state, metadata, notice or watchdog after losing ownership during the coordinator read', async () => {
    let owned = true;
    const lost = new StepOwnershipLostError(operationId, 1);
    const stateManager = {
      loadAgentState: vi.fn(async () => {
        owned = false;
        return { status: 'running' };
      }),
      saveAgentState: vi.fn(),
    };
    const coordinator = new AgentRuntimeCoordinator({
      stateManager: stateManager as any,
      streamEventManager: {} as any,
    });
    const notice = vi.fn(),
      scheduleMessage = vi.fn();
    await expect(
      parkForClientLlm(
        {
          agentOperationModel: { recordCompletion: vi.fn().mockResolvedValue(true) },
          coordinator,
          messageModel: {
            findLatestAssistantByOperationId: vi.fn().mockResolvedValue({ id: 'assistant' }),
          },
          queueService: { scheduleMessage },
          updateAssistantRowWithRetry: notice,
        } as any,
        operationId,
        state() as any,
        { phase: 'user_input' } as any,
        undefined,
        undefined,
        async () => {
          if (!owned) throw lost;
        },
      ),
    ).rejects.toBe(lost);
    expect(stateManager.saveAgentState).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(scheduleMessage).not.toHaveBeenCalled();
  });

  it('does not arm the watchdog after the waiting notice yields ownership', async () => {
    let owned = true;
    const lost = new StepOwnershipLostError(operationId, 1);
    const scheduleMessage = vi.fn();
    await expect(
      parkForClientLlm(
        {
          agentOperationModel: { recordCompletion: vi.fn().mockResolvedValue(true) },
          coordinator: { saveAgentState: vi.fn() },
          messageModel: {
            findLatestAssistantByOperationId: vi.fn().mockResolvedValue({ id: 'assistant' }),
          },
          queueService: { scheduleMessage },
          updateAssistantRowWithRetry: vi.fn(async () => {
            owned = false;
          }),
        } as any,
        operationId,
        state() as any,
        { phase: 'user_input' } as any,
        undefined,
        undefined,
        async () => {
          if (!owned) throw lost;
        },
      ),
    ).rejects.toBe(lost);
    expect(scheduleMessage).not.toHaveBeenCalled();
  });

  it('does not retry an assistant write after losing ownership during backoff', async () => {
    let owned = true;
    const lost = new StepOwnershipLostError(operationId, 1);
    const update = vi.fn(async () => {
      owned = false;
      throw new Error('transient');
    });
    await expect(
      updateAssistantRowWithRetry(
        { messageModel: { update } } as any,
        operationId,
        'assistant',
        {},
        async () => {
          if (!owned) throw lost;
        },
      ),
    ).rejects.toBe(lost);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('propagates an ownership failure from the assistant write without retrying it', async () => {
    const lost = new StepOwnershipLostError(operationId, 1);
    const update = vi.fn().mockRejectedValue(lost);

    await expect(
      updateAssistantRowWithRetry(
        { messageModel: { update } } as any,
        operationId,
        'assistant',
        {},
      ),
    ).rejects.toBe(lost);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
