// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DURABLE_LEASE_HEARTBEAT_EVERY_TICKS,
  STEP_LOCK_HEARTBEAT_MS,
} from '../AgentRuntimeService/constants';
import { StaleOperationReaper } from '../StaleOperationReaper';

const hatchet = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/server/modules/Hatchet/config', () => ({
  isHatchetDeliveryEnabled: () => hatchet.enabled,
}));

const claimStaleRedriveMock = vi.fn();
const settleStaleRunningMock = vi.fn();
const releaseStaleRedriveMock = vi.fn();
vi.mock('@/server/modules/Tenant/callbackUrl');
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: vi.fn().mockImplementation(function () {
    return {
      claimStaleRedrive: claimStaleRedriveMock,
      releaseStaleRedrive: releaseStaleRedriveMock,
      settleStaleRunning: settleStaleRunningMock,
    };
  }),
}));

const finalizeAbandonedMock = vi.fn().mockResolvedValue({});
vi.mock('../AbandonOperationService', () => ({
  AbandonOperationService: vi.fn().mockImplementation(function () {
    return { finalizeAbandoned: finalizeAbandonedMock };
  }),
}));

/** The tenant's Redis service client, where Hatchet mode keeps the sweep cursor. */
const redis = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock('@/server/services/redis/client', () => ({
  getRedisServiceClient: async (scope: string) => (scope === 'agentRuntime' ? redis : null),
}));

/**
 * Minimal drizzle select chains: the stale-candidate query (`orderBy`) answers
 * its n-th page with `page(n)`, the concurrent-foreground patrol (`groupBy`)
 * returns `overlapRows`.
 */
const buildPagedDb = (page: (call: number) => any[], overlapRows: any[] = []) => {
  const candidatePages = vi.fn(async () => page(candidatePages.mock.calls.length - 1));
  return {
    candidatePages,
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: () => ({
            having: () => ({ limit: vi.fn().mockResolvedValue(overlapRows) }),
          }),
          orderBy: () => ({ limit: candidatePages }),
        }),
      }),
    }),
  } as any;
};

const buildDb = (rows: any[], overlapRows: any[] = []) =>
  buildPagedDb((call) => (call === 0 ? rows : []), overlapRows);

const CREATED_AT = new Date('2026-10-30T10:00:00.000Z');

const candidate = (id = 'op_x') => ({
  createdAt: CREATED_AT,
  id,
  threadId: null,
  topicId: 'tpc_x',
  updatedAt: '2026-10-30 10:05:00.000001+00',
  userId: 'user_x',
  workspaceId: null,
});

const buildCoordinator = (
  state: any,
  history: any[] = [],
  isInterrupted: (id: string) => boolean = () => false,
) => ({
  getExecutionHistory: vi.fn().mockResolvedValue(history),
  isInterrupted: vi.fn(async (id: string) => isInterrupted(id)),
  loadAgentState: vi.fn().mockResolvedValue(state),
});
const buildQueue = () => ({ scheduleMessage: vi.fn().mockResolvedValue('msg_1') });

const runningState = (overrides: Record<string, any> = {}) => ({
  metadata: {},
  status: 'running',
  stepCount: 7,
  ...overrides,
});

/** `saveStepResult` files the context for step N+1 under producing step N. */
const historyFor = (stepIndex: number, context: any = { phase: 'tool_result' }) => [
  { context: { phase: 'llm_result' }, stepIndex: stepIndex - 1 },
  { context, stepIndex },
];

const buildReaper = (
  rows: any[],
  state: any,
  queue: any = buildQueue(),
  history: any[] = historyFor(6),
) =>
  new StaleOperationReaper(buildDb(rows), {
    coordinator: buildCoordinator(state, history) as any,
    queueService: queue as any,
  });

describe('StaleOperationReaper', () => {
  beforeEach(() => {
    hatchet.enabled = false;
    claimStaleRedriveMock.mockReset().mockResolvedValue(1);
    settleStaleRunningMock.mockReset().mockResolvedValue(true);
    releaseStaleRedriveMock.mockReset().mockResolvedValue(true);
    finalizeAbandonedMock.mockClear();
    process.env.APP_URL = 'https://app.lobehub.test';
  });

  it('re-queues the unfinished step of a resumable operation', async () => {
    const queue = buildQueue();
    const result = await buildReaper([candidate()], runningState(), queue).sweep();

    expect(queue.scheduleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        // The context step 6 produced for step 7 — without it `runtime.step`
        // would synthesize a `user_input` context and drop the pending work.
        context: { phase: 'tool_result' },
        // stepCount is the count of COMPLETED steps, so it is also the index
        // of the one that never finished.
        endpoint: 'https://app.lobehub.test/orgs/acme/api/agent/run',
        operationId: 'op_x',
        stepIndex: 7,
      }),
    );
    expect(finalizeAbandonedMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ abandoned: 0, examined: 1, redriven: 1 });
  });

  it('keys deduplication per attempt so a later redrive is not deduped away', async () => {
    const queue = buildQueue();
    claimStaleRedriveMock.mockResolvedValue(2);

    await buildReaper([candidate()], runningState(), queue).sweep();

    expect(queue.scheduleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ deduplicationId: 'stale-redrive:op_x:7:2' }),
    );
  });

  it('redrives step 0 with the context the operation was created with', async () => {
    // Born-dead shape: state exists but is still `idle` at step 0. There is no
    // producing step, so the context comes off the state — the same field the
    // intervention continuation re-publishes from.
    const queue = buildQueue();
    await buildReaper(
      [candidate()],
      runningState({ initialContext: { phase: 'user_input' }, status: 'idle', stepCount: 0 }),
      queue,
      [],
    ).sweep();

    expect(queue.scheduleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ context: { phase: 'user_input' }, stepIndex: 0 }),
    );
  });

  it('skips rather than abandons when the step context cannot be recovered', async () => {
    // `getExecutionHistory` swallows a failed LRANGE and returns [], so an
    // empty result cannot be told apart from a transient Redis failure.
    // Retiring is irreversible, and this operation is otherwise resumable.
    const queue = buildQueue();
    const result = await buildReaper([candidate()], runningState(), queue, []).sweep();

    expect(queue.scheduleMessage).not.toHaveBeenCalled();
    expect(claimStaleRedriveMock).not.toHaveBeenCalled();
    expect(settleStaleRunningMock).not.toHaveBeenCalled();
    expect(finalizeAbandonedMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ abandoned: 0, redriven: 0, skipped: 1 });
  });

  it('never touches an operation with no coordinator state', async () => {
    // This is the shape of a HEALTHY heterogeneous run: an external Claude
    // Code / Codex CLI drives it, it never creates coordinator state, and it
    // only refreshes its lease on `heteroIngest` batches — so one long tool
    // call reads as stale here. Retiring it would make `heteroIngest` drop
    // every subsequent batch of a live session.
    const queue = buildQueue();
    const result = await buildReaper([candidate()], null, queue).sweep();

    expect(queue.scheduleMessage).not.toHaveBeenCalled();
    expect(claimStaleRedriveMock).not.toHaveBeenCalled();
    expect(finalizeAbandonedMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ abandoned: 0, redriven: 0, skipped: 1 });
  });

  it.each(['waiting_for_human', 'waiting_for_async_tool'])(
    'never redrives a deliberately parked operation (%s)',
    async (status) => {
      const queue = buildQueue();
      const result = await buildReaper([candidate()], runningState({ status }), queue).sweep();

      expect(queue.scheduleMessage).not.toHaveBeenCalled();
      expect(finalizeAbandonedMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ skipped: 1 });
    },
  );

  it('does not recover the async-tool CAS-to-enqueue gap while Redis remains parked', async () => {
    // The candidate query only returns DB rows marked running. After the CAS
    // wins, the Redis snapshot remains parked until the queued step executes.
    hatchet.enabled = true;
    const queue = buildQueue();
    const result = await buildReaper(
      [candidate()],
      runningState({ status: 'waiting_for_async_tool' }),
      queue,
    ).sweep();
    expect(queue.scheduleMessage).not.toHaveBeenCalled();
    expect(claimStaleRedriveMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, redriven: 0 });
  });

  it('leaves an operation alone when a heartbeat wins the claim race', async () => {
    const queue = buildQueue();
    claimStaleRedriveMock.mockResolvedValue(null);
    // The stale CAS finds the row refreshed → the step is alive and owns itself
    // again, so nothing irreversible may happen to it.
    settleStaleRunningMock.mockResolvedValue(false);

    const result = await buildReaper([candidate()], runningState(), queue).sweep();

    expect(queue.scheduleMessage).not.toHaveBeenCalled();
    expect(finalizeAbandonedMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alive: 1, redriven: 0 });
  });

  it('abandons once the redrive budget is spent', async () => {
    const queue = buildQueue();
    claimStaleRedriveMock.mockResolvedValue(null);
    // CAS still matches → the claim failed on the attempt budget, not a heartbeat.
    settleStaleRunningMock.mockResolvedValue(true);

    const result = await buildReaper([candidate()], runningState(), queue).sweep();

    expect(queue.scheduleMessage).not.toHaveBeenCalled();
    expect(settleStaleRunningMock).toHaveBeenCalledWith('op_x', expect.any(Date));
    // The claim already retired the row, so the lifecycle must be told —
    // otherwise its own completion write is refused and no hooks fire.
    expect(finalizeAbandonedMock).toHaveBeenCalledWith('op_x', 'stale_lease_redrive_exhausted', {
      settledAsAbandoned: true,
    });
    expect(result).toMatchObject({ abandoned: 1 });
  });

  it('refuses to abandon a run that heartbeated after the candidate was selected', async () => {
    // `listStaleRunning` selected this row, then the worker resumed while the
    // sweep was doing its Redis reads. Abandoning is irreversible and
    // user-visible, so it must re-check the lease atomically rather than
    // trust the stale select.
    const queue = buildQueue();
    claimStaleRedriveMock.mockResolvedValue(null);
    settleStaleRunningMock.mockResolvedValue(false);

    const result = await buildReaper([candidate()], runningState(), queue).sweep();

    expect(finalizeAbandonedMock).not.toHaveBeenCalled();
    expect(queue.scheduleMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ abandoned: 0, alive: 1 });
  });

  it('gives the attempt back when the redrive fails to publish', async () => {
    // The budget bounds LLM spend; a delivery that never went out spent
    // nothing. Without the release, a brief queue outage walks a healthy
    // operation to its attempt limit and retires it having never recovered.
    const queue = buildQueue();
    queue.scheduleMessage.mockRejectedValue(new Error('qstash down'));
    claimStaleRedriveMock.mockResolvedValue(2);

    const result = await buildReaper([candidate()], runningState(), queue).sweep();

    expect(releaseStaleRedriveMock).toHaveBeenCalledWith('op_x', 2);
    expect(finalizeAbandonedMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ abandoned: 0, failed: 1, redriven: 0 });
  });

  it('keeps the attempt when the redrive publishes successfully', async () => {
    const result = await buildReaper([candidate()], runningState()).sweep();

    expect(releaseStaleRedriveMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ redriven: 1 });
  });

  it('keeps sweeping after one operation throws', async () => {
    const queue = buildQueue();
    queue.scheduleMessage
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValueOnce('msg_2');

    const result = await buildReaper(
      [candidate('op_a'), candidate('op_b')],
      runningState(),
      queue,
    ).sweep();

    expect(result).toMatchObject({ examined: 2, failed: 1, redriven: 1 });
  });

  it.each([
    [true, 180_000],
    [false, 300_000],
  ])('uses the delivery-mode lease threshold (Hatchet: %s)', async (enabled, expected) => {
    hatchet.enabled = enabled;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await buildReaper([candidate()], runningState()).sweep();
      const elapsed = now - claimStaleRedriveMock.mock.calls[0][1].getTime();
      expect(elapsed).toBe(expected);
      if (enabled)
        expect(elapsed).toBeGreaterThanOrEqual(
          2 * STEP_LOCK_HEARTBEAT_MS * DURABLE_LEASE_HEARTBEAT_EVERY_TICKS,
        );
    } finally {
      clock.mockRestore();
    }
  });

  it('passes the caller stall window through to the claim', async () => {
    const before = Date.now();
    await buildReaper([candidate()], runningState()).sweep({ staleAfterMs: 60_000 });

    const [, staleBefore, maxAttempts] = claimStaleRedriveMock.mock.calls[0];
    expect(maxAttempts).toBe(3);
    expect(staleBefore.getTime()).toBeLessThanOrEqual(before - 60_000 + 5);
  });

  it('reports topics with more than one foreground run live', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const overlap = { operationIds: ['op_a', 'op_b'], topicId: 'tpc_x' };
    const reaper = new StaleOperationReaper(buildDb([], [overlap]), {
      coordinator: buildCoordinator(null) as any,
      queueService: buildQueue() as any,
    });

    const result = await reaper.sweep();

    expect(result.concurrentForegroundTopics).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[StaleOperationReaper] concurrent foreground operations on one topic',
      { ...overlap, unstoppedOperationIds: ['op_a'] },
    );
    warn.mockRestore();
  });

  it('ignores an overlap whose older runs were already asked to stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const overlap = { operationIds: ['op_a', 'op_b'], topicId: 'tpc_x' };
    const reaper = new StaleOperationReaper(buildDb([], [overlap]), {
      coordinator: buildCoordinator(null, [], (id) => id === 'op_a') as any,
      queueService: buildQueue() as any,
    });

    const result = await reaper.sweep();

    expect(result.concurrentForegroundTopics).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still reports recovery results when the patrol query fails', async () => {
    const db = buildDb([candidate()]);
    const select = db.select;
    let calls = 0;
    db.select = () => {
      calls += 1;
      if (calls === 1) return select();
      throw new Error('db down');
    };
    const reaper = new StaleOperationReaper(db, {
      coordinator: buildCoordinator(runningState(), historyFor(6)) as any,
      queueService: buildQueue() as any,
    });

    const result = await reaper.sweep();

    expect(result).toMatchObject({ concurrentForegroundTopics: 0, redriven: 1 });
  });

  it('without a delivery probe it neither reads the envelope, refreshes state nor keeps a cursor', async () => {
    const coordinator = {
      ...buildCoordinator(runningState(), historyFor(6)),
      loadInlineResume: vi.fn(),
      touchOperation: vi.fn(),
    };
    const result = await new StaleOperationReaper(buildDb([candidate()]), {
      coordinator: coordinator as any,
      queueService: buildQueue() as any,
    }).sweep();

    expect(coordinator.loadInlineResume).not.toHaveBeenCalled();
    expect(coordinator.touchOperation).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ redriven: 1 });
  });

  describe('with a delivery probe', () => {
    /** In-memory stand-in for the Redis sweep cursor. */
    const memoryCursor = (initial?: { id: string; updatedAt: string }, cycleStart?: number) => {
      const store = {
        load: vi.fn(async () => store.value),
        save: vi.fn(
          async (position?: { cursor: { id: string; updatedAt: string }; cycleStart: number }) => {
            store.value = position;
          },
        ),
        value: initial ? { cursor: initial, cycleStart: cycleStart ?? Date.now() } : undefined,
      };
      return store;
    };

    const buildProbed = (
      probe: (operationId: string, checkpoint: any) => Promise<'active' | 'none' | 'unknown'>,
      {
        db = buildDb([candidate()]),
        envelope = async () => null as any,
        sweepCursor = memoryCursor(),
      }: { db?: any; envelope?: () => Promise<any>; sweepCursor?: any } = {},
    ) => {
      const coordinator = {
        ...buildCoordinator(runningState(), historyFor(6)),
        loadInlineResume: vi.fn(envelope),
        touchOperation: vi.fn().mockResolvedValue(undefined),
      };
      const deliveryProbe = vi.fn(probe);
      const queue = buildQueue();
      const reaper = new StaleOperationReaper(db, {
        coordinator: coordinator as any,
        deliveryProbe,
        queueService: queue as any,
        sweepCursor,
      });
      return { coordinator, db, deliveryProbe, queue, reaper, sweepCursor };
    };

    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      redis.get.mockReset();
      redis.set.mockReset();
      redis.del.mockReset();
    });
    afterEach(() => {
      warn.mockRestore();
      vi.useRealTimers();
    });

    it('leaves the attempt budget alone while Hatchet holds the next step', async () => {
      const { coordinator, queue, reaper } = buildProbed(async () => 'active');

      const result = await reaper.sweep();

      expect(claimStaleRedriveMock).not.toHaveBeenCalled();
      expect(queue.scheduleMessage).not.toHaveBeenCalled();
      expect(finalizeAbandonedMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ redriven: 0, skipped: 1 });
      expect(result.skippedReasons).toMatchObject({ delivery_active: 1 });
      expect(warn).not.toHaveBeenCalled();
      // The queued delivery may wait past the state TTL before it runs.
      expect(coordinator.touchOperation).toHaveBeenCalledWith('op_x');
    });

    it('refreshes a queued operation even when its recovery context is unavailable', async () => {
      const { coordinator, reaper } = buildProbed(async () => 'active');
      coordinator.getExecutionHistory.mockResolvedValue([]);
      const result = await reaper.sweep();
      expect(result.skippedReasons.delivery_active).toBe(1);
      expect(coordinator.touchOperation).toHaveBeenCalledWith('op_x');
      expect(claimStaleRedriveMock).not.toHaveBeenCalled();
    });

    it('does not expose envelope error text in the structured warning', async () => {
      const { reaper } = buildProbed(async () => 'none', {
        envelope: async () => {
          throw new Error('secret message');
        },
      });
      await reaper.sweep();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret message');
    });

    it('skips, warns and keeps the state when the probe cannot tell', async () => {
      const { coordinator, queue, reaper } = buildProbed(async () => 'unknown');

      const result = await reaper.sweep();

      expect(claimStaleRedriveMock).not.toHaveBeenCalled();
      expect(queue.scheduleMessage).not.toHaveBeenCalled();
      expect(result.skippedReasons).toMatchObject({ delivery_unknown: 1 });
      expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
        event: 'agent.reaper.delivery_probe_unknown',
        operationId: 'op_x',
        stepCount: 7,
      });
      expect(coordinator.touchOperation).toHaveBeenCalledWith('op_x');
    });

    it('treats an envelope it cannot read as unknown', async () => {
      const { coordinator, deliveryProbe, reaper } = buildProbed(async () => 'none', {
        envelope: async () => {
          throw new Error('Connection is closed.');
        },
      });

      const result = await reaper.sweep();

      expect(deliveryProbe).not.toHaveBeenCalled();
      expect(claimStaleRedriveMock).not.toHaveBeenCalled();
      expect(result.skippedReasons).toMatchObject({ delivery_unknown: 1 });
      expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
        event: 'agent.reaper.delivery_probe_unknown',
        operationId: 'op_x',
      });
      expect(coordinator.touchOperation).toHaveBeenCalledWith('op_x');
    });

    it('treats a probe that throws as unknown', async () => {
      const { reaper } = buildProbed(async () => {
        throw new Error('boom');
      });

      const result = await reaper.sweep();

      expect(claimStaleRedriveMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ failed: 0, skipped: 1 });
      expect(result.skippedReasons).toMatchObject({ delivery_unknown: 1 });
    });

    it('redrives as before when nothing is in flight, checking against the parked envelope', async () => {
      const { coordinator, deliveryProbe, queue, reaper } = buildProbed(async () => 'none', {
        envelope: async () => ({ context: { secret: 'payload' }, stepIndex: 9 }),
      });

      const result = await reaper.sweep();

      expect(deliveryProbe).toHaveBeenCalledWith('op_x', {
        createdAt: CREATED_AT,
        envelopeStepIndex: 9,
        stepCount: 7,
      });
      expect(claimStaleRedriveMock).toHaveBeenCalledTimes(1);
      expect(queue.scheduleMessage).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: 'op_x', stepIndex: 7 }),
      );
      // Refreshed before the redrive is handed over: it may queue as long as any delivery.
      expect(coordinator.touchOperation).toHaveBeenCalledWith('op_x');
      expect(coordinator.touchOperation.mock.invocationCallOrder[0]).toBeLessThan(
        queue.scheduleMessage.mock.invocationCallOrder[0],
      );
      expect(result).toMatchObject({ redriven: 1, skipped: 0 });
    });

    it('passes the creation time and no envelope index when nothing is parked', async () => {
      const { deliveryProbe, reaper } = buildProbed(async () => 'none');
      await reaper.sweep();
      expect(deliveryProbe).toHaveBeenCalledWith('op_x', { createdAt: CREATED_AT, stepCount: 7 });
    });

    it.each(['active', 'none'] as const)(
      'does not let a failed state refresh change the outcome (%s)',
      async (delivery) => {
        const { coordinator, reaper } = buildProbed(async () => delivery);
        coordinator.touchOperation.mockRejectedValue(new Error('redis down'));

        const result = await reaper.sweep();

        expect(result).toMatchObject(
          delivery === 'active' ? { failed: 0, skipped: 1 } : { failed: 0, redriven: 1 },
        );
      },
    );

    describe('fair scanning', () => {
      const ids = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => candidate(`op_${from + i}`));

      it('pages past skipped candidates: the 51st is recovered when the first 50 are queued', async () => {
        const db = buildPagedDb((call) => [ids(0, 50), ids(50, 1)][call] ?? []);
        const { queue, reaper } = buildProbed(
          async (operationId) => (operationId === 'op_50' ? 'none' : 'active'),
          { db },
        );

        const result = await reaper.sweep();

        expect(queue.scheduleMessage).toHaveBeenCalledTimes(1);
        expect(queue.scheduleMessage).toHaveBeenCalledWith(
          expect.objectContaining({ operationId: 'op_50' }),
        );
        expect(result).toMatchObject({ examined: 51, redriven: 1, skipped: 50 });
        expect(result.skippedReasons).toMatchObject({ delivery_active: 50 });
      });

      it('stops once the recoveries reach the limit', async () => {
        const db = buildPagedDb((call) => [ids(0, 3), ids(3, 3)][call] ?? []);
        const { queue, reaper } = buildProbed(async () => 'none', { db });

        const result = await reaper.sweep({ limit: 3 });

        expect(db.candidatePages).toHaveBeenCalledTimes(1);
        expect(queue.scheduleMessage).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({ examined: 3, redriven: 3 });
      });

      it('stops at the page budget and leaves the next sweep a cursor after the last candidate', async () => {
        const db = buildPagedDb((call) => ids(call * 50, 50));
        const { reaper, sweepCursor } = buildProbed(async () => 'active', { db });

        const result = await reaper.sweep();

        expect(db.candidatePages).toHaveBeenCalledTimes(10);
        expect(result).toMatchObject({ examined: 500, redriven: 0, skipped: 500 });
        expect(sweepCursor.save).toHaveBeenCalledWith({
          cursor: { id: 'op_499', updatedAt: candidate().updatedAt },
          cycleStart: expect.any(Number),
        });
      });

      it('stops at the time budget, the cursor naming the last candidate it looked at', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
        const db = buildPagedDb((call) => ids(call * 50, 50));
        const { reaper, sweepCursor } = buildProbed(
          async () => {
            vi.setSystemTime(Date.now() + 6_000);
            return 'active';
          },
          { db },
        );

        const result = await reaper.sweep();

        // 20s budget, 6s per candidate: the fifth would start past the deadline.
        expect(result).toMatchObject({ examined: 4, skipped: 4 });
        expect(sweepCursor.value).toMatchObject({ cursor: { id: 'op_3' } });
      });

      it('clears the cursor once a sweep reaches the newest candidate, so the next wraps around', async () => {
        const sweepCursor = memoryCursor({ id: 'op_9', updatedAt: candidate().updatedAt });
        const { reaper } = buildProbed(async () => 'active', { sweepCursor });

        await reaper.sweep();

        expect(sweepCursor.save).toHaveBeenCalledWith(undefined);
        expect(sweepCursor.value).toBeUndefined();
      });

      it('starts from the oldest when the cursor cannot be read, and survives failing to save it', async () => {
        const sweepCursor = {
          load: vi.fn().mockRejectedValue(new Error('redis down')),
          save: vi.fn().mockRejectedValue(new Error('redis down')),
        };
        const { reaper } = buildProbed(async () => 'none', { sweepCursor });

        const result = await reaper.sweep();

        expect(result).toMatchObject({ examined: 1, redriven: 1 });
      });

      it('warns when a full scan takes longer than thirty minutes', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
        // A sweep that reaches the newest candidate completes a cycle started
        // 31 minutes ago: the 2h state TTL may expire before the next visit.
        const sweepCursor = memoryCursor(
          { id: 'op_9', updatedAt: candidate().updatedAt },
          Date.now() - 31 * 60_000,
        );
        const { reaper } = buildProbed(async () => 'active', { sweepCursor });

        await reaper.sweep();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
          event: 'agent.reaper.scan_cycle_slow',
        });
        expect(sweepCursor.value).toBeUndefined();
      });

      it('stays quiet when a full scan finishes within thirty minutes', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
        const sweepCursor = memoryCursor(
          { id: 'op_9', updatedAt: candidate().updatedAt },
          Date.now() - 29 * 60_000,
        );
        const { reaper } = buildProbed(async () => 'active', { sweepCursor });

        await reaper.sweep();

        expect(warn).not.toHaveBeenCalled();
        expect(sweepCursor.value).toBeUndefined();
      });

      it('starts a new cycle when sweeping from the oldest', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
        const sweepCursor = memoryCursor();
        const db = buildPagedDb((call) => ids(call, 1));
        const { reaper } = buildProbed(async () => 'active', { db, sweepCursor });

        await reaper.sweep({ limit: 1 });

        expect(sweepCursor.value?.cycleStart).toBe(Date.now());
      });

      it('keeps the cursor in the tenant’s Redis by default, with a TTL', async () => {
        const db = buildPagedDb((call) => ids(call * 50, 50));
        const coordinator = {
          ...buildCoordinator(runningState(), historyFor(6)),
          loadInlineResume: vi.fn(async () => null),
          touchOperation: vi.fn(async () => {}),
        };

        await new StaleOperationReaper(db, {
          coordinator: coordinator as any,
          deliveryProbe: async () => 'active',
          queueService: buildQueue() as any,
        }).sweep();

        expect(redis.get).toHaveBeenCalledWith('stale_sweep_cursor:v1');
        expect(redis.set).toHaveBeenCalledWith('stale_sweep_cursor:v1', expect.any(String), {
          ex: expect.any(Number),
        });
        expect(JSON.parse(redis.set.mock.calls[0][1])).toEqual({
          cycleStart: expect.any(Number),
          id: 'op_499',
          updatedAt: candidate().updatedAt,
        });
      });

      it('preserves the cycle start in Redis across sweeps and warns on completion', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] });
        let stored: string | undefined;
        redis.get.mockImplementation(async () => stored);
        redis.set.mockImplementation(async (_key: string, value: string) => {
          stored = value;
        });
        redis.del.mockImplementation(async () => {
          stored = undefined;
        });
        const db = buildPagedDb((call) => (call < 10 ? ids(call * 50, 50) : []));
        const coordinator = {
          ...buildCoordinator(runningState(), historyFor(6)),
          loadInlineResume: vi.fn(async () => null),
          touchOperation: vi.fn(async () => {}),
        };
        const reaper = new StaleOperationReaper(db, {
          coordinator: coordinator as any,
          deliveryProbe: async () => 'active',
          queueService: buildQueue() as any,
        });

        const startedAt = Date.now();
        await reaper.sweep();
        expect(JSON.parse(stored!).cycleStart).toBe(startedAt);
        vi.setSystemTime(startedAt + 31 * 60_000);
        await reaper.sweep();

        expect(stored).toBeUndefined();
        expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({
          elapsedMs: 31 * 60_000,
          event: 'agent.reaper.scan_cycle_slow',
        });
      });
    });
  });
});
