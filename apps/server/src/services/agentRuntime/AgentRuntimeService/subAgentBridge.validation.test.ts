import { getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { completeSubAgentBridge } from './subAgentBridge';
import { validateSubAgentBridge } from './validateSubAgentBridge';

const mocks = vi.hoisted(() => ({ enabled: true, claim: vi.fn(), delivered: vi.fn() }));
vi.mock('@/server/modules/Hatchet/config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isHatchetDeliveryEnabled: () => mocks.enabled,
}));
vi.mock('@/server/services/gatewayAuthorization/parentExecution', () => ({
  gatewayParentMayResume: async () => true,
}));
vi.mock('@/database/models/agentSubAgentBridge', () => ({
  AgentSubAgentBridgeModel: class {
    claim = mocks.claim;
    release = vi.fn().mockResolvedValue(true);
    markDelivered = mocks.delivered;
  },
}));

const params = {
  operationId: 'child',
  parentOperationId: 'parent',
  reason: 'done',
  threadId: 'thread',
  toolMessageId: 'tool',
};

function setup() {
  const binding = {
    childOperationId: 'child',
    childRunToken: 'generation',
    includeShareVisitor: false,
    parentOperationId: 'parent',
    status: 'pending',
    threadId: 'thread',
    toolMessageId: 'tool',
    userId: 'user',
    waitingBatchId: 'batch',
    workspaceId: null,
  };
  const child = {
    id: 'child',
    parentOperationId: 'parent',
    threadId: 'thread',
    userId: 'user',
    workspaceId: null,
  };
  const parent = {
    id: 'parent',
    status: 'waiting_for_async_tool',
    userId: 'user',
    workspaceId: null,
  };
  const thread = {
    id: 'thread',
    metadata: { runToken: 'generation', operationId: 'child' },
    userId: 'user',
    workspaceId: null,
  };
  const message = { id: 'tool', parentId: 'batch', userId: 'user', workspaceId: null };
  const plugin = { id: 'tool', toolCallId: 'call' };
  const state = { status: 'waiting_for_async_tool', pendingToolsCalling: [{ id: 'call' }] };
  const rows: Record<string, any> = {
    agent_sub_agent_bridges: binding,
    agent_operations: { child, parent },
    threads: thread,
    message_plugins: plugin,
  };
  let opIndex = 0;
  const select = vi.fn(() => ({
    from: (table: Parameters<typeof getTableName>[0]) => ({
      where: () => ({
        limit: async () => {
          const name = getTableName(table);
          const row =
            name === 'agent_operations'
              ? rows[name][opIndex++ % 2 === 0 ? 'child' : 'parent']
              : rows[name];
          return row ? [row] : [];
        },
      }),
    }),
  }));
  const deps = {
    serverDB: { select },
    userId: 'user',
    workspaceId: undefined,
    coordinator: {
      loadAgentState: vi.fn(async (id: string) =>
        id === 'parent' ? state : { messages: [{ role: 'assistant', content: 'answer' }] },
      ),
    },
    isCallSubAgentToolMessage: vi.fn().mockResolvedValue(false),
    controlCompletedToolResult: vi.fn().mockResolvedValue({ result: { content: 'answer' } }),
    messageModel: {
      findById: vi.fn(async () => message),
      updateToolMessage: vi.fn().mockResolvedValue({ success: true }),
    },
    tryResumeParentFromAsyncTool: vi.fn().mockResolvedValue(true),
  };
  return { binding, child, deps, message, parent, plugin, rows, state, thread, select };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.enabled = true;
  mocks.claim.mockReset().mockResolvedValue(true);
  mocks.delivered.mockReset();
});

const rejectionLogs = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.flatMap(([line]) => {
    try {
      const record = JSON.parse(String(line));
      return record?.event === 'subagent.bridge.rejected' ? [record] : [];
    } catch {
      return [];
    }
  });

describe('durable sub-agent bridge validation', () => {
  it('retries an early callback and succeeds once the parent waits', async () => {
    const x = setup();
    x.parent.status = 'running';
    x.state.status = 'running';
    x.state.pendingToolsCalling = [];
    await expect(completeSubAgentBridge(x.deps as never, params)).rejects.toThrow(
      'Sub-agent bridge parent not yet waiting',
    );
    expect(mocks.delivered).not.toHaveBeenCalled();
    expect(x.deps.messageModel.updateToolMessage).not.toHaveBeenCalled();
    x.parent.status = 'waiting_for_async_tool';
    x.state.status = 'waiting_for_async_tool';
    x.state.pendingToolsCalling = [{ id: 'call' }];
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(true);
    expect(mocks.delivered).toHaveBeenCalledOnce();
  });

  it('acknowledges an already delivered bridge even if the parent is running again', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const x = setup();
    x.binding.status = 'delivered';
    x.parent.status = 'running';
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(false);
    expect(x.deps.messageModel.updateToolMessage).not.toHaveBeenCalled();
    expect(rejectionLogs(info)).toEqual([
      {
        event: 'subagent.bridge.rejected',
        operationId: 'child',
        parentOperationId: 'parent',
        reason: 'binding_settled',
      },
    ]);
  });

  it('delivers a child spawned without a binding through the pre-binding path', async () => {
    const x = setup();
    x.rows.agent_sub_agent_bridges = null;
    // The parent's resume CAS: only the first delivery can flip the parked parent.
    let parentResumed = false;
    x.deps.tryResumeParentFromAsyncTool.mockImplementation(async () => {
      if (parentResumed) return false;
      parentResumed = true;
      return true;
    });

    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(true);
    expect(x.deps.messageModel.updateToolMessage).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({ content: 'answer', onlyIfEmpty: true }),
    );
    expect(x.deps.tryResumeParentFromAsyncTool).toHaveBeenCalledWith(
      { childOperationId: 'child', parentOperationId: 'parent' },
      { knownFulfilledMessageId: 'tool', scheduleVerifyOnHold: true },
    );

    // A duplicate callback only repeats the idempotent backfill and loses the CAS.
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(false);
    expect(x.deps.messageModel.updateToolMessage).toHaveBeenCalledTimes(2);
    expect(x.deps.messageModel.updateToolMessage).toHaveBeenLastCalledWith(
      'tool',
      expect.objectContaining({ onlyIfEmpty: true }),
    );
    expect(parentResumed).toBe(true);
    // No binding row exists to lease or settle.
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it('backfills the card of a parent stopped while parked without resuming it', async () => {
    const x = setup();
    // Stop rewrites the Redis state only; the parked row keeps waiting_for_async_tool.
    x.state.status = 'interrupted';
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(false);
    expect(x.deps.messageModel.updateToolMessage).toHaveBeenCalledOnce();
    expect(x.deps.messageModel.updateToolMessage).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({ content: 'answer', onlyIfEmpty: true }),
    );
    expect(x.deps.tryResumeParentFromAsyncTool).not.toHaveBeenCalled();
    // The binding stays pending so recovery can still settle or resume it.
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it('backfills but does not resume a parent that waits on another call', async () => {
    const x = setup();
    x.state.pendingToolsCalling = [{ id: 'other' }];
    expect(await validateSubAgentBridge(x.deps as never, params)).toEqual({
      allowed: false,
      reason: 'tool_not_pending',
    });
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(false);
    expect(x.deps.messageModel.updateToolMessage).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({ onlyIfEmpty: true }),
    );
    expect(x.deps.tryResumeParentFromAsyncTool).not.toHaveBeenCalled();
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it('retries while an idle parent has not started', async () => {
    const x = setup();
    x.parent.status = 'idle';
    await expect(completeSubAgentBridge(x.deps as never, params)).rejects.toThrow(
      'Sub-agent bridge parent not yet waiting',
    );
    expect(mocks.delivered).not.toHaveBeenCalled();
  });

  it.each(['done', 'abandoned', 'error', 'interrupted'])(
    'backfills but does not resume a terminal parent (%s)',
    async (status) => {
      const x = setup();
      x.parent.status = status;
      expect(await completeSubAgentBridge(x.deps as never, params)).toBe(false);
      expect(x.deps.messageModel.updateToolMessage).toHaveBeenCalledWith(
        'tool',
        expect.objectContaining({ onlyIfEmpty: true }),
      );
      expect(x.deps.tryResumeParentFromAsyncTool).not.toHaveBeenCalled();
      expect(mocks.delivered).not.toHaveBeenCalled();
    },
  );

  it('backfills and resumes a matching pending bridge', async () => {
    const { deps } = setup();
    expect(await completeSubAgentBridge(deps as never, params)).toBe(true);
    expect(deps.messageModel.updateToolMessage).toHaveBeenCalledOnce();
    expect(deps.tryResumeParentFromAsyncTool).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'stale_generation',
      (x: ReturnType<typeof setup>) => {
        x.thread.metadata.runToken = 'new-generation';
      },
    ],
    [
      'batch_mismatch',
      (x: ReturnType<typeof setup>) => {
        x.message.parentId = 'new-batch';
      },
    ],
    [
      'ownership_mismatch',
      (x: ReturnType<typeof setup>) => {
        x.child.userId = 'other';
      },
    ],
  ])('rejects and logs %s before backfill or resume', async (reason, change) => {
    const x = setup();
    change(x);
    expect(await validateSubAgentBridge(x.deps as never, params)).toEqual({
      allowed: false,
      reason,
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(false);
    expect(x.deps.controlCompletedToolResult).not.toHaveBeenCalled();
    expect(x.deps.messageModel.updateToolMessage).not.toHaveBeenCalled();
    expect(x.deps.tryResumeParentFromAsyncTool).not.toHaveBeenCalled();
    expect(mocks.delivered).not.toHaveBeenCalled();
    expect(rejectionLogs(info)).toEqual([
      {
        event: 'subagent.bridge.rejected',
        operationId: 'child',
        parentOperationId: 'parent',
        reason,
      },
    ]);
  });

  it.each([
    [
      'child parent',
      (x: ReturnType<typeof setup>) => {
        x.child.parentOperationId = 'other';
      },
    ],
    [
      'parent workspace',
      (x: ReturnType<typeof setup>) => {
        (x.parent as { workspaceId: string | null }).workspaceId = 'other';
      },
    ],
    [
      'visitor scope',
      (x: ReturnType<typeof setup>) => {
        x.binding.includeShareVisitor = true;
      },
    ],
    [
      'callback tool',
      (x: ReturnType<typeof setup>) => {
        x.binding.toolMessageId = 'other';
      },
    ],
  ])('rejects mismatched %s', async (_name, change) => {
    const x = setup();
    change(x);
    expect(await validateSubAgentBridge(x.deps as never, params)).toEqual({
      allowed: false,
      reason: 'ownership_mismatch',
    });
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(false);
    expect(x.deps.messageModel.updateToolMessage).not.toHaveBeenCalled();
    expect(x.deps.tryResumeParentFromAsyncTool).not.toHaveBeenCalled();
  });

  it('rejects a previous operation in the same thread', async () => {
    const x = setup();
    x.thread.metadata.operationId = 'new-child';
    expect(await validateSubAgentBridge(x.deps as never, params)).toEqual({
      allowed: false,
      reason: 'stale_generation',
    });
  });

  it('propagates storage failures so the callback can be retried', async () => {
    const x = setup();
    x.deps.messageModel.findById.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(completeSubAgentBridge(x.deps as never, params)).rejects.toThrow(
      'storage unavailable',
    );
    expect(x.deps.messageModel.updateToolMessage).not.toHaveBeenCalled();
    expect(x.deps.tryResumeParentFromAsyncTool).not.toHaveBeenCalled();
  });

  it('keeps the non-Hatchet path and does not read bindings', async () => {
    mocks.enabled = false;
    const x = setup();
    expect(await completeSubAgentBridge(x.deps as never, params)).toBe(true);
    expect(x.select).not.toHaveBeenCalled();
    expect(x.deps.messageModel.updateToolMessage).toHaveBeenCalledOnce();
    expect(x.deps.tryResumeParentFromAsyncTool).toHaveBeenCalledOnce();
  });
});
