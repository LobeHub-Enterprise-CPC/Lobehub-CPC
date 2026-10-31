// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tryResumeParentFromAsyncTool } from './AgentRuntimeService/asyncTool';
import { AsyncToolResumeReconciler } from './AsyncToolResumeReconciler';
import { SubAgentBridgeReconciler } from './SubAgentBridgeReconciler';

const mocks = vi.hoisted(() => ({
  enabled: true,
  bridgeList: vi.fn(),
  bridgeRecovered: vi.fn(),
  bridgeFailed: vi.fn(),
  findOperation: vi.fn(),
  findMessage: vi.fn(),
  note: vi.fn(),
  cas: vi.fn(),
  claim: vi.fn(),
  confirm: vi.fn(),
  list: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    findById = mocks.findOperation;
    noteAsyncToolResumeScan = mocks.note;
    tryResumeFromAsyncTool = mocks.cas;
    claimAsyncToolResume = mocks.claim;
    confirmAsyncToolResume = mocks.confirm;
    listPendingAsyncToolResumes = mocks.list;
    renewAsyncToolResume = mocks.renew;
    releaseAsyncToolResume = mocks.release;
  },
}));
vi.mock('@/server/modules/Hatchet/config', () => ({
  isHatchetDeliveryEnabled: () => mocks.enabled,
}));
vi.mock('@/server/services/gatewayAuthorization/operationAuthority', () => ({
  assertGatewayStateExecution: vi.fn(),
}));
vi.mock('@/server/modules/Hatchet/probe', () => ({ createHatchetDeliveryProbe: vi.fn() }));
vi.mock('@/server/modules/AgentRuntime', () => ({
  AgentRuntimeCoordinator: class {
    loadAgentState = (...args: unknown[]) => load(...args);
  },
}));
vi.mock('@/database/models/agentSubAgentBridge', () => ({
  AgentSubAgentBridgeModel: class {
    listTerminalRecoverable = mocks.bridgeList;
    claim = vi.fn().mockResolvedValue(true);
    release = vi.fn();
    markRecovered = mocks.bridgeRecovered;
    markFailed = mocks.bridgeFailed;
  },
}));
vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    findById = mocks.findMessage;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({ AiAgentService: class {} }));
vi.mock('./AgentRuntimeService/validateSubAgentBridge', () => ({
  validateSubAgentBridge: async () => ({ allowed: false, reason: 'tool_not_pending' }),
}));
vi.mock('@/server/services/queue', () => ({ QueueService: class {} }));
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantCallbackUrl: () => 'http://localhost/api/agent',
}));

const old = new Date('2026-10-30T11:00:00.000Z');
const intent = {
  createdAt: old.toISOString(),
  deduplicationId: 'initial',
  payload: { resumeAsyncTool: true },
  state: 'pending',
  stepIndex: 4,
  waitingToolCallIds: ['tool'],
};
const candidate = {
  scannedAt: old.toISOString(),
  id: 'parent',
  userId: 'user',
  workspaceId: null,
  createdAt: old,
  intent,
};
const state = {
  status: 'waiting_for_async_tool',
  stepCount: 4,
  pendingToolsCalling: [{ id: 'tool' }],
};
const load = vi.fn();
const probe = vi.fn();
const schedule = vi.fn();
const reconciler = () =>
  new AsyncToolResumeReconciler({} as never, {
    coordinator: { loadAgentState: load, touchOperation: vi.fn() } as never,
    deliveryProbe: probe,
    queueService: { scheduleMessage: schedule } as never,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled = true;
  mocks.list.mockResolvedValue([candidate]);
  mocks.claim.mockResolvedValue(true);
  mocks.confirm.mockResolvedValue(true);
  mocks.renew.mockResolvedValue(true);
  mocks.release.mockResolvedValue(true);
  load.mockResolvedValue(state);
  probe.mockResolvedValue('none');
  schedule.mockResolvedValue('run');
});

describe('async tool resume reconciliation', () => {
  it('redrives the saved resume with a new generation and confirms it', async () => {
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'parent',
        stepIndex: 4,
        payload: { resumeAsyncTool: true },
        deduplicationId: expect.not.stringMatching(/^initial$/),
      }),
    );
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });
  it.each(['active', 'unknown'])('waits when delivery status is %s', async (result) => {
    probe.mockResolvedValue(result);
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).not.toHaveBeenCalled();
  });
  it('confirms an already advanced parent without publishing again', async () => {
    load.mockResolvedValue({ status: 'running', stepCount: 5 });
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });
  it('does not publish when another instance holds the claim', async () => {
    mocks.claim.mockResolvedValue(false);
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).not.toHaveBeenCalled();
  });
  it('does not run in non-Hatchet mode', async () => {
    mocks.enabled = false;
    await reconciler().sweep();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each(['publish failure', 'crash after CAS'])('recovers once after %s', async (failure) => {
    let durable: typeof intent | undefined;
    let claimed = false;
    let resumed = 0;
    mocks.cas.mockImplementation(async (_parent, _child, saved) => {
      durable = saved;
      if (failure === 'crash after CAS') throw new Error('simulated crash');
      return true;
    });
    mocks.list.mockImplementation(async () =>
      durable?.state === 'pending' ? [{ ...candidate, intent: durable }] : [],
    );
    mocks.claim.mockImplementation(async (_id, previous, next) => {
      if (claimed || durable?.deduplicationId !== previous) return false;
      claimed = true;
      durable = { ...durable, deduplicationId: next };
      return true;
    });
    mocks.confirm.mockImplementation(async (_id, key) => {
      if (durable?.deduplicationId !== key) return false;
      durable = { ...durable, state: 'confirmed' };
      return true;
    });
    mocks.release.mockImplementation(async () => {
      claimed = false;
    });
    schedule.mockImplementation(async () => {
      resumed++;
      load.mockResolvedValue({ status: 'running', stepCount: 5 });
      return 'run';
    });
    const producerSchedule =
      failure === 'publish failure'
        ? vi.fn().mockRejectedValue(new Error('publish failed'))
        : vi.fn();
    const deps = {
      allPendingToolsFulfilled: vi.fn().mockResolvedValue(true),
      baseURL: 'http://localhost/api/agent',
      coordinator: { loadAgentState: load },
      maybeScheduleAsyncToolVerify: vi.fn(),
      queueService: { scheduleMessage: producerSchedule },
      resolveAsyncToolOnComplete: vi.fn().mockResolvedValue('resume'),
      serverDB: {},
      userId: 'user',
    } as unknown as Parameters<typeof tryResumeParentFromAsyncTool>[0];
    await expect(
      tryResumeParentFromAsyncTool(deps, { parentOperationId: 'parent' }),
    ).rejects.toThrow();
    expect(durable?.state).toBe('pending');
    await reconciler().sweep(new Date(Date.now() + 120_000));
    await reconciler().sweep(new Date(Date.now() + 120_000));
    expect(resumed).toBe(1);
    expect(durable?.state).toBe('confirmed');

    // The bridge backfill precedes the CAS. Replaying the intent has advanced
    // the parent, but the crashed callback never settled its binding.
    let bridgeStatus = 'pending';
    const binding = {
      id: 'bridge',
      childOperationId: 'child',
      parentOperationId: 'parent',
      toolMessageId: 'message',
      waitingBatchId: 'batch',
      threadId: 'thread',
      userId: 'user',
      workspaceId: null,
      includeShareVisitor: false,
      createdAt: old,
      updatedAt: old,
    };
    mocks.bridgeList.mockImplementation(async () =>
      bridgeStatus === 'pending' ? [{ binding, child: { status: 'done', completedAt: old } }] : [],
    );
    mocks.bridgeRecovered.mockImplementation(async () => {
      bridgeStatus = 'recovered';
      return true;
    });
    mocks.findOperation.mockResolvedValue({
      status: 'done',
      metadata: { asyncToolResumeIntent: durable },
    });
    mocks.findMessage.mockResolvedValue({ parentId: 'batch', content: 'child result' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bridgeReconciler = new SubAgentBridgeReconciler({} as never);
      await bridgeReconciler.sweep(new Date(old.getTime() + 120_000));
      await bridgeReconciler.sweep(new Date(old.getTime() + 120_000));
      expect(bridgeStatus).toBe('recovered');
      expect(mocks.bridgeRecovered).toHaveBeenCalledOnce();
      expect(mocks.bridgeFailed).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(resumed).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('waits for an accepted publication whose acknowledgement was lost, then recognizes progress', async () => {
    probe.mockResolvedValue('active');
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    load.mockResolvedValue({ status: 'running', stepCount: 5 });
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });

  it('allows only one of two concurrent sweepers to publish', async () => {
    let held = false;
    mocks.claim.mockImplementation(async () => {
      if (held) return false;
      held = true;
      return true;
    });
    let finish!: () => void;
    schedule.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve('run');
        }),
    );
    const first = reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).toHaveBeenCalledOnce();
    finish();
    await first;
  });
  it('leaves an unknown or older waiting batch pending', async () => {
    load.mockResolvedValue({
      status: 'waiting_for_async_tool',
      stepCount: 4,
      pendingToolsCalling: [{ id: 'other' }],
    });
    await reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
    expect(schedule).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('does not publish after its recovery lease is lost', async () => {
    vi.useFakeTimers();
    try {
      mocks.renew.mockResolvedValue(false);
      let finishProbe!: () => void;
      probe.mockResolvedValueOnce('none').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishProbe = () => resolve('none');
          }),
      );
      const work = reconciler().sweep(new Date('2026-10-30T12:00:00.000Z'));
      for (let i = 0; i < 30 && !finishProbe; i++) await Promise.resolve();
      expect(finishProbe).toBeDefined();
      await vi.advanceTimersByTimeAsync(40_000);
      finishProbe();
      await work;
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
