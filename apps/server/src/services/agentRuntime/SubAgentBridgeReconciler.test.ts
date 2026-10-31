// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubAgentBridgeReconciler } from './SubAgentBridgeReconciler';

const mocks = vi.hoisted(() => ({
  enabled: true,
  list: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
  recovered: vi.fn(),
  failed: vi.fn(),
  validate: vi.fn(),
  complete: vi.fn(),
  findOperation: vi.fn(),
  loadState: vi.fn(),
  update: vi.fn(),
  findMessage: vi.fn(),
}));

vi.mock('@/server/modules/Hatchet/config', () => ({
  isHatchetDeliveryEnabled: () => mocks.enabled,
}));
vi.mock('@/database/models/agentSubAgentBridge', () => ({
  AgentSubAgentBridgeModel: class {
    listTerminalRecoverable = mocks.list;
    claim = mocks.claim;
    release = mocks.release;
    renew = mocks.renew;
    markRecovered = mocks.recovered;
    markFailed = mocks.failed;
  },
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    findById = mocks.findOperation;
  },
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    updateToolMessage = mocks.update;
    findById = mocks.findMessage;
  },
}));
vi.mock('@/server/modules/AgentRuntime', () => ({
  AgentRuntimeCoordinator: class {
    loadAgentState = mocks.loadState;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    completeSubAgentBridge = mocks.complete;
  },
}));
vi.mock('@/server/services/gatewayAuthorization/parentExecution', () => ({
  gatewayParentMayResume: async () => true,
}));
vi.mock('./AgentRuntimeService/validateSubAgentBridge', () => ({
  validateSubAgentBridge: mocks.validate,
}));

const now = new Date('2026-10-30T12:00:00Z');
const binding = {
  childOperationId: 'child',
  parentOperationId: 'parent',
  threadId: 'thread',
  toolMessageId: 'tool',
  userId: 'user',
  workspaceId: 'workspace',
  includeShareVisitor: false,
  id: 'id',
  waitingBatchId: 'batch',
  updatedAt: new Date(now.getTime() - 120_000),
  createdAt: new Date(now.getTime() - 120_000),
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.findMessage.mockResolvedValue({ parentId: 'batch', content: '' });
  mocks.list
    .mockResolvedValueOnce([{ binding, child: { status: 'done', completedAt: binding.createdAt } }])
    .mockResolvedValue([]);
  mocks.claim.mockResolvedValue(true);
  mocks.release.mockResolvedValue(true);
  mocks.renew.mockResolvedValue(true);
  mocks.recovered.mockResolvedValue(true);
  mocks.failed.mockResolvedValue(true);
  mocks.validate.mockResolvedValue({ allowed: true });
  mocks.findOperation.mockResolvedValue({ status: 'waiting_for_async_tool' });
  mocks.complete.mockResolvedValue(true);
  mocks.loadState.mockResolvedValue({ status: 'waiting_for_async_tool' });
  mocks.update.mockResolvedValue({ success: true, applied: true });
});

describe('sub-agent bridge reconciliation', () => {
  it('replays an aged terminal child in its workspace and records recovery', async () => {
    const result = await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(result.recovered).toBe(1);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'child' }));
    expect(mocks.recovered).toHaveBeenCalled();
  });

  it('releases a lease for a temporarily unavailable parent', async () => {
    mocks.validate.mockResolvedValue({ allowed: false, reason: 'parent_not_waiting' });
    await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('does not run outside Hatchet mode', async () => {
    mocks.enabled = false;
    await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each(['stale_generation', 'ownership_mismatch'])(
    'fails a permanently invalid binding: %s',
    async (reason) => {
      mocks.validate.mockResolvedValue({ allowed: false, reason });
      const result = await new SubAgentBridgeReconciler({} as never).sweep(now);
      expect(result.failed).toBe(1);
      expect(mocks.failed).toHaveBeenCalledWith(
        'child',
        expect.any(String),
        expect.any(Date),
        reason,
      );
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );

  it.each(['done', 'error', 'interrupted', 'abandoned', 'running', 'waiting_for_async_tool'])(
    'settles an already backfilled result after the parent advances to %s without warning',
    async (status) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mocks.findOperation.mockResolvedValue({ status });
        mocks.validate.mockResolvedValue({
          allowed: false,
          reason: status === 'running' ? 'parent_not_waiting' : 'tool_not_pending',
        });
        mocks.findMessage.mockResolvedValue({ parentId: 'batch', content: 'child answer' });
        const reconciler = new SubAgentBridgeReconciler({} as never);
        const first = await reconciler.sweep(now);
        const second = await reconciler.sweep(now);
        expect(first.recovered).toBe(1);
        expect(first.failed).toBe(0);
        expect(second.processed).toBe(0);
        expect(mocks.recovered).toHaveBeenCalledOnce();
        expect(mocks.failed).not.toHaveBeenCalled();
        expect(mocks.complete).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each(['ownership_mismatch', 'stale_generation', 'batch_mismatch'])(
    'does not accept a backfill as delivery for an invalid binding: %s',
    async (reason) => {
      mocks.findOperation.mockResolvedValue({ status: 'done' });
      mocks.validate.mockResolvedValue({ allowed: false, reason });
      mocks.findMessage.mockResolvedValue({ parentId: 'batch', content: 'child answer' });
      await new SubAgentBridgeReconciler({} as never).sweep(now);
      expect(mocks.recovered).not.toHaveBeenCalled();
      expect(mocks.failed).toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    { parentId: 'batch', content: '' },
    { parentId: 'other-batch', content: 'unrelated answer' },
  ])('does not mistake a missing, empty or unrelated result for delivery: %j', async (message) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.findOperation.mockResolvedValue({ status: 'done' });
      mocks.findMessage.mockResolvedValue(message);
      const result = await new SubAgentBridgeReconciler({} as never).sweep(now);
      expect(result.failed).toBe(1);
      expect(mocks.failed).toHaveBeenCalledWith(
        'child',
        expect.any(String),
        expect.any(Date),
        'parent_terminal',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('subagent.bridge.reconcile.failed'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['done', 'error', 'interrupted', 'abandoned'])(
    'fails when the parent is terminal: %s',
    async (status) => {
      mocks.findOperation.mockResolvedValue({ status });
      const result = await new SubAgentBridgeReconciler({} as never).sweep(now);
      expect(result.failed).toBe(1);
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['error', 'error'],
    ['abandoned', 'error'],
    ['interrupted', 'interrupted'],
  ])('replays child %s as %s', async (status, reason) => {
    mocks.list
      .mockReset()
      .mockResolvedValue([{ binding, child: { status, completedAt: binding.createdAt } }]);
    await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ reason }));
  });

  it('writes a failure result through the bridge and warns when the window expires', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.list
      .mockReset()
      .mockResolvedValue([
        { binding, child: { status: 'done', completedAt: new Date(now.getTime() - 7_201_000) } },
      ]);
    const result = await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(result.failed).toBe(1);
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'error',
        errorMessage: expect.stringContaining('recovery window'),
      }),
    );
    expect(mocks.failed).toHaveBeenCalledWith(
      'child',
      expect.any(String),
      expect.any(Date),
      'recovery_window_expired',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('subagent.bridge.reconcile.failed'));
    warn.mockRestore();
  });

  it('records a missing waiting state as a failure without attempting to resume', async () => {
    mocks.validate.mockResolvedValue({ allowed: false, reason: 'tool_not_pending' });
    mocks.loadState.mockResolvedValue(null);
    const result = await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(result.failed).toBe(1);
    expect(mocks.update).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({
        onlyIfEmpty: true,
        content: expect.stringContaining('unavailable'),
      }),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('lets only one concurrent sweeper hold a candidate lease', async () => {
    mocks.list
      .mockReset()
      .mockResolvedValue([{ binding, child: { status: 'done', completedAt: binding.createdAt } }]);
    let held = false;
    mocks.claim.mockImplementation(async () => {
      if (held) return false;
      held = true;
      return true;
    });
    let finish!: () => void;
    mocks.complete.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = new SubAgentBridgeReconciler({} as never).sweep(now);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    const second = await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(second.skipped).toBe(1);
    finish();
    await first;
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it('retries a candidate once an earlier worker lease expires', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      mocks.list
        .mockReset()
        .mockResolvedValue([
          { binding, child: { status: 'done', completedAt: binding.createdAt } },
        ]);
      const heldUntil = now.getTime() + 60_000;
      mocks.claim.mockImplementation(
        async (_id, _owner, current: Date) => current.getTime() >= heldUntil,
      );
      const first = await new SubAgentBridgeReconciler({} as never).sweep(now);
      expect(first.skipped).toBe(1);
      vi.setSystemTime(heldUntil + 1);
      const second = await new SubAgentBridgeReconciler({} as never).sweep(new Date(heldUntil + 1));
      expect(second.recovered).toBe(1);
      expect(mocks.complete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews the lease while bridge completion exceeds its original duration', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      let finish!: () => void;
      mocks.complete.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const sweep = new SubAgentBridgeReconciler({} as never).sweep(now);
      for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
      expect(finish).toBeDefined();
      await vi.advanceTimersByTimeAsync(121_000);
      expect(mocks.renew).toHaveBeenCalled();
      finish();
      await sweep;
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts and logs a binding whose processing threw instead of hiding it as a skip', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.validate.mockRejectedValue(
        Object.assign(new Error('could not read tool message "secret"'), { code: '57P01' }),
      );

      const result = await new SubAgentBridgeReconciler({} as never).sweep(now);

      expect(result).toEqual({ errors: 1, failed: 0, processed: 1, recovered: 0, skipped: 0 });
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.parse(error.mock.calls[0][0] as string)).toEqual({
        childOperationId: 'child',
        errorCode: '57P01',
        errorName: 'Error',
        event: 'subagent.bridge.reconcile.error',
        id: 'id',
        reason: 'processing_error',
      });
      // Identifiers only: an error message can carry message contents.
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
      expect(mocks.release).toHaveBeenCalledWith('child', expect.any(String));
    } finally {
      error.mockRestore();
    }
  });

  it('stops at its time budget, leaving the remaining bindings to the next sweep', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);
      mocks.list.mockReset().mockResolvedValueOnce(
        ['a', 'b', 'c'].map((id) => ({
          binding: { ...binding, childOperationId: `child-${id}`, id },
          child: { status: 'done', completedAt: binding.createdAt },
        })),
      );
      mocks.list.mockResolvedValue([]);
      // Each replay takes 15 s of the sweep's 20 s budget.
      mocks.complete.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 15_000);
      });

      const result = await new SubAgentBridgeReconciler({} as never).sweep(now);

      expect(mocks.complete.mock.calls.map(([params]) => params.operationId)).toEqual([
        'child-a',
        'child-b',
      ]);
      expect(result).toMatchObject({ processed: 2, recovered: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances by the last (updatedAt, id) pair even when earlier rows settle', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      binding: { ...binding, id: String(i) },
      child: { status: 'done', completedAt: binding.createdAt },
    }));
    mocks.list.mockReset().mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    await new SubAgentBridgeReconciler({} as never).sweep(now);
    expect(mocks.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: '49', updatedAt: binding.updatedAt } }),
    );
  });
});
