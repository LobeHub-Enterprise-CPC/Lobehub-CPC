import { beforeEach, describe, expect, it, vi } from 'vitest';

import { execAgentThreadRun } from './subAgentRuns';

const hatchet = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/server/modules/Hatchet/config', () => ({
  isHatchetDeliveryEnabled: () => hatchet.enabled,
}));
vi.mock('@/server/services/agentRuntime/hooks', () => ({
  hookDispatcher: { dispatch: vi.fn().mockResolvedValue(undefined) },
}));

const params = {
  agentId: 'agent',
  instruction: 'go',
  parentMessageId: 'tool',
  parentOperationId: 'parent',
  topicId: 'topic',
};
const options = {
  isSubAgent: true,
  logScope: 'execVirtualSubAgent' as const,
  resumeParentOnComplete: true,
};
let queued: boolean;
let create: ReturnType<typeof vi.fn>;
let deps: Parameters<typeof execAgentThreadRun>[0];

beforeEach(() => {
  hatchet.enabled = false;
  queued = false;
  create = vi.fn().mockResolvedValue(undefined);
  deps = {
    agentOperationModel: { findById: vi.fn().mockResolvedValue({}) },
    agentRuntimeService: {},
    bridgeModel: { create },
    execAgent: vi.fn(async (input) => {
      await input.onOperationCreated?.('child');
      queued = true;
      return { operationId: 'child', success: true };
    }),
    messageModel: { findById: vi.fn().mockResolvedValue({ parentId: 'assistant-batch' }) },
    threadModel: {
      create: vi.fn().mockResolvedValue({ id: 'thread' }),
      update: vi.fn(),
      linkRunOperation: vi.fn(),
      failRun: vi.fn().mockResolvedValue(undefined),
    },
    userId: 'user',
  } as unknown as Parameters<typeof execAgentThreadRun>[0];
});

describe('sub-agent bridge binding', () => {
  it('persists the current identity before queuing in Hatchet mode', async () => {
    hatchet.enabled = true;
    await execAgentThreadRun(deps, params, options);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        childOperationId: 'child',
        parentOperationId: 'parent',
        threadId: 'thread',
        toolMessageId: 'tool',
        childRunToken: expect.any(String),
        waitingBatchId: 'assistant-batch',
        userId: 'user',
      }),
    );
    expect(queued).toBe(true);
  });
  it('does not write a binding outside Hatchet mode', async () => {
    await execAgentThreadRun(deps, params, options);
    expect(create).not.toHaveBeenCalled();
    expect(queued).toBe(true);
  });
  it('does not queue a child without a verifiable parent batch', async () => {
    hatchet.enabled = true;
    vi.mocked(deps.messageModel.findById).mockResolvedValueOnce(undefined);
    await expect(execAgentThreadRun(deps, params, options)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(queued).toBe(false);
  });
  it('treats failure to read the parent batch as retryable', async () => {
    hatchet.enabled = true;
    vi.mocked(deps.messageModel.findById).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(execAgentThreadRun(deps, params, options)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(create).not.toHaveBeenCalled();
    expect(queued).toBe(false);
  });
  it('does not queue the child when persistence fails', async () => {
    hatchet.enabled = true;
    create.mockRejectedValue(new Error('database unavailable'));
    await expect(execAgentThreadRun(deps, params, options)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(queued).toBe(false);
  });
});
