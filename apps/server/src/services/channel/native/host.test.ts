// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { channelNativeError, reconcileChannelNative, startChannelNative } from './host';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareApproval: vi.fn(),
  load: vi.fn(),
  submitted: vi.fn(),
  exec: vi.fn(),
  state: vi.fn(),
  interrupt: vi.fn(),
  retire: vi.fn(),
  findOperation: vi.fn(),
  schedule: vi.fn(),
  accepted: vi.fn(),
  fail: vi.fn(),
  publish: vi.fn(),
  saveDraft: vi.fn(),
  releaseWriter: vi.fn(),
  recordExecution: vi.fn(),
  executionUnknown: vi.fn(),
  requestApproval: vi.fn(),
  resumeAfterApproval: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@/database/models/channelNative', () => ({
  ChannelNativeModel: class {
    prepare = mocks.prepare;
    prepareApproval = mocks.prepareApproval;
    load = mocks.load;
    submitted = mocks.submitted;
  },
}));
vi.mock('@/database/models/channel', () => ({
  ChannelModel: class {
    constructor() {
      return mocks;
    }
  },
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    findById = mocks.findOperation;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    execAgent = mocks.exec;
    loadInterventionContinuationState = mocks.state;
    interruptTask = mocks.interrupt;
    retirePendingApprovalOperation = mocks.retire;
  },
}));
vi.mock('@/server/services/queue', () => ({
  QueueService: class {
    scheduleMessage = mocks.schedule;
  },
}));
vi.mock('./capabilities', () => ({
  loadChannelNativeCapabilities: async () => ({
    userInterventionConfig: { approvalMode: 'auto-run', allowList: [] },
  }),
}));
const run = {
  id: 'run',
  channelId: 'channel',
  sessionId: 'session',
  fence: 1,
  executionFence: 1,
  executionConfig: {
    agentId: 'agent',
    model: 'stale-model',
    provider: 'stale-provider',
    systemRole: 'stale-prompt',
    runtime: 'native',
  },
  manifest: {
    messages: [
      { id: 'message', sequence: 1, content: 'request', author: { name: 'User', type: 'human' } },
    ],
    requestMessageId: 'message',
    threadId: null,
    self: { name: 'Member', memberId: 'member' },
  },
};
const operation = {
  operationId: 'op',
  topicId: 'real-topic',
  ready: true,
  submitted: true,
  stepIndex: 0,
  createdAt: new Date(),
};
let loaded: any;
const input = { db: {}, ownerId: 'owner', run } as any;
beforeEach(() => {
  vi.resetAllMocks();
  loaded = {
    run,
    operations: [{ ...operation }],
    effects: [],
    checkpoint: {
      activeMs: 2,
      modelCalls: 1,
      toolCalls: 0,
      receipt: {
        operationId: 'op',
        status: 'done',
        content: 'actual answer',
        model: 'latest',
        provider: 'latest-provider',
      },
    },
  };
  mocks.load.mockImplementation(async () => loaded);
  mocks.prepare.mockResolvedValue({ operation, run, fresh: true, reconstruct: false });
  mocks.exec.mockResolvedValue({
    success: true,
    autoStarted: true,
    operationId: 'op',
    topicId: 'real-topic',
  });
  mocks.state.mockResolvedValue({ status: 'done' });
  mocks.findOperation.mockResolvedValue({ status: 'done' });
});
describe('Channel standard runtime bridge', () => {
  it('starts the original agent with extra attributed context, without membership config overrides', async () => {
    await startChannelNative(input);
    expect(mocks.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent',
        operationId: 'op',
        appContext: { topicId: 'real-topic' },
        autoStart: true,
        topicConfigPolicy: 'agent',
        channelRun: { runId: 'run', fence: 1 },
      }),
    );
    const params = mocks.exec.mock.calls[0][0];
    expect(params.model).toBeUndefined();
    expect(params.provider).toBeUndefined();
    expect(params.instructions).toContain('Member');
    expect(params.prompt).toContain('request');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('does not repeat execAgent after a lost startup acknowledgement', async () => {
    mocks.prepare.mockResolvedValue({ operation, run, fresh: false });
    await startChannelNative(input);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it('requeues only the existing prepared operation when autoStarted is false', async () => {
    mocks.exec.mockResolvedValue({ success: true, autoStarted: false });
    loaded.operations[0].submitted = false;
    await startChannelNative(input);
    await reconcileChannelNative(input, false);
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op', deduplicationId: 'channel-start:op' }),
    );
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });
  it('preserves startup rejection before a ready checkpoint', async () => {
    loaded.operations[0].ready = false;
    mocks.exec.mockResolvedValue({
      success: false,
      autoStarted: false,
      error: 'Provider credential rejected',
    });
    await expect(startChannelNative(input)).rejects.toThrow('Provider credential rejected');
  });
  it('keeps an ambiguously submitted operation for reconciliation', async () => {
    mocks.exec.mockRejectedValue(new Error('ACK lost'));
    await expect(startChannelNative(input)).resolves.toBeUndefined();
    expect(mocks.fail).not.toHaveBeenCalled();
  });
  it.each(['running', 'waiting_for_async_tool', 'waiting_for_human'])(
    'never publishes %s as a final response',
    async (status) => {
      mocks.state.mockResolvedValue({ status });
      mocks.findOperation.mockResolvedValue({ status });
      await reconcileChannelNative(input, false);
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.releaseWriter).not.toHaveBeenCalled();
    },
  );
  it('publishes the final receipt and releases the writer after restart', async () => {
    await reconcileChannelNative(input, false);
    expect(mocks.saveDraft).toHaveBeenCalledWith('channel', 'run', 1, 'actual answer');
    expect(mocks.recordExecution).toHaveBeenCalledWith(
      'channel',
      'run',
      1,
      expect.objectContaining({ model: 'latest' }),
    );
    expect(mocks.publish).toHaveBeenCalled();
    expect(mocks.releaseWriter).toHaveBeenCalled();
  });
  it('does not mistake a preceding turn receipt for the new reply', async () => {
    loaded.checkpoint.receipt.operationId = 'old-operation';
    await reconcileChannelNative(input, false);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalled();
  });
  it('retains the writer for unconfirmed tool termination, even after runtime completion', async () => {
    loaded.effects = [{ settled: false }];
    await reconcileChannelNative(input, false);
    expect(mocks.releaseWriter).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.executionUnknown).toHaveBeenCalled();
  });
  it('cancels all operations but waits for the actual transport completion', async () => {
    loaded.effects = [{ settled: false }];
    await reconcileChannelNative(input, true);
    expect(mocks.interrupt).toHaveBeenCalled();
    expect(mocks.releaseWriter).not.toHaveBeenCalled();
    loaded.effects[0].settled = true;
    await reconcileChannelNative(input, true);
    expect(mocks.releaseWriter).toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('resumes all approved tools in one durable standard continuation', async () => {
    const tools = [{ id: 'one' }, { id: 'two' }];
    mocks.state.mockResolvedValue({
      status: 'waiting_for_human',
      pendingToolsCalling: tools,
      pendingToolMessageIds: { one: 'msg-one', two: 'msg-two' },
    });
    mocks.requestApproval.mockResolvedValue({ decision: 'approved' });
    await reconcileChannelNative(input, false);
    expect(mocks.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalSourceOperationId: 'op',
        approvalResolutionRequestId: 'channel:op',
        resumeApprovals: [
          { decision: 'approved', parentMessageId: 'msg-one', toolCallId: 'one' },
          { decision: 'approved', parentMessageId: 'msg-two', toolCallId: 'two' },
        ],
      }),
    );
    expect(mocks.retire).toHaveBeenCalledWith('op');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('recovers approved intent after replacement interrupted the source and preparation failed', async () => {
    loaded.checkpoint.approvalIntent = {
      operationId: 'op',
      pendingToolsCalling: [{ id: 'one' }],
      pendingToolMessageIds: { one: 'msg-one' },
    };
    mocks.state.mockResolvedValue({ status: 'interrupted' });
    mocks.findOperation.mockResolvedValue({ status: 'waiting_for_human' });
    mocks.requestApproval.mockResolvedValue({ decision: 'approved' });
    mocks.exec.mockRejectedValueOnce(new Error('temporary preparation error'));
    await expect(reconcileChannelNative(input, false)).rejects.toThrow('preparation');
    await reconcileChannelNative(input, false);
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    expect(mocks.exec.mock.calls.map(([p]) => p.approvalResolutionRequestId)).toEqual([
      'channel:op',
      'channel:op',
    ]);
    expect(mocks.prepareApproval).toHaveBeenCalledTimes(2);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each(['activeMs', 'approvalSince'])(
    'expires persisted %s without publishing or releasing an unsettled writer',
    async (field) => {
      loaded.checkpoint[field] =
        field === 'activeMs' ? 24 * 60 * 60_000 : Date.now() - 24 * 60 * 60_000;
      loaded.effects = [{ settled: false }];
      await reconcileChannelNative(input, false);
      expect(mocks.fail).toHaveBeenCalled();
      expect(mocks.interrupt).toHaveBeenCalled();
      expect(mocks.releaseWriter).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );
  it('preserves the structured provider error in the failed run', async () => {
    mocks.findOperation.mockResolvedValue({
      status: 'error',
      error: { message: 'Provider rejected', body: { code: 401 } },
    });
    await reconcileChannelNative(input, false);
    expect(mocks.fail.mock.calls[0][3]).toContain('401');
  });
  it('keeps nested error causes', () =>
    expect(
      channelNativeError(new Error('Gateway failed', { cause: new Error('connection reset') })),
    ).toBe('Gateway failed: connection reset'));
});
