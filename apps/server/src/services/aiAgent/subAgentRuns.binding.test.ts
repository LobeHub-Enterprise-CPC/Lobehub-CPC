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
  // The callSubAgent runner drops its pending placeholder only for a returned
  // failed start; a throw left that row behind next to a second error row.
  const expectFailedStart = async (error: string) => {
    await expect(execAgentThreadRun(deps, params, options)).resolves.toMatchObject({
      error,
      success: false,
      threadId: 'thread',
    });
    expect(deps.threadModel.failRun).toHaveBeenCalledWith(
      'thread',
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining(error) }),
    );
    expect(deps.threadModel.linkRunOperation).not.toHaveBeenCalled();
    expect(queued).toBe(false);
  };
  it('does not queue a child without a verifiable parent batch', async () => {
    hatchet.enabled = true;
    vi.mocked(deps.messageModel.findById).mockResolvedValueOnce(undefined);
    await expectFailedStart('Sub-agent bridge parent batch unavailable');
  });
  it('treats failure to read the parent batch as a failed start', async () => {
    hatchet.enabled = true;
    vi.mocked(deps.messageModel.findById).mockRejectedValueOnce(new Error('database unavailable'));
    await expectFailedStart('Sub-agent bridge persistence unavailable');
    expect(create).not.toHaveBeenCalled();
  });
  it('does not queue the child when persistence fails', async () => {
    hatchet.enabled = true;
    create.mockRejectedValue(new Error('database unavailable'));
    await expectFailedStart('Sub-agent bridge persistence unavailable');
  });
  it('still throws other startup failures', async () => {
    vi.mocked(deps.execAgent).mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(execAgentThreadRun(deps, params, options)).rejects.toThrow('queue unavailable');
    expect(deps.threadModel.failRun).toHaveBeenCalledOnce();
  });
});
