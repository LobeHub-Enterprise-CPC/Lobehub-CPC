// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  armSubAgentDeadline,
  checkSubAgentDeadline,
  CLAIM_SETTLE_MS,
  DEFAULT_FIRST_STEP_DEADLINE_MS,
  FIRST_STEP_DEADLINE_ENV,
  FIRST_STEP_NEVER_STARTED,
  MIN_FIRST_STEP_DEADLINE_MS,
  neverClaimedStep,
  resolveFirstStepDeadlineMs,
  SUB_AGENT_TIMEOUT,
  subAgentDeadlineViolation,
} from '../SubAgentDeadline';

const SPAWNED_AT = Date.parse('2026-10-26T06:52:41.571Z');

/**
 * The shape the production row had: created, then never touched again (the
 * creation write sits ~100ms after `started_at`).
 */
const runningRow = (overrides: Record<string, any> = {}) => ({
  id: 'op_child',
  llmCalls: null,
  startedAt: new Date(SPAWNED_AT),
  status: 'running',
  stepCount: null,
  toolCalls: null,
  updatedAt: new Date(SPAWNED_AT + 102),
  ...overrides,
});

const buildDeps = (row: any) => ({
  abandon: vi.fn().mockResolvedValue({
    assistantMessageUpdated: true,
    finalized: false,
    found: true,
  }),
  agentOperationModel: { findById: vi.fn().mockResolvedValue(row) } as any,
  resumeParent: vi.fn().mockResolvedValue(undefined),
});

describe('neverClaimedStep', () => {
  it('treats a row that never moved after its creation write as never claimed', () => {
    expect(neverClaimedStep(runningRow(), SPAWNED_AT)).toBe(true);
  });

  it('treats a running step as claimed once the lease heartbeat moved `updatedAt`', () => {
    // step_count counts COMPLETED steps, so an in-flight step 0 still reads 0 —
    // the lease is what distinguishes it from a dropped delivery.
    expect(
      neverClaimedStep(
        runningRow({ updatedAt: new Date(SPAWNED_AT + CLAIM_SETTLE_MS + 60_000) }),
        SPAWNED_AT,
      ),
    ).toBe(false);
  });

  it('never treats a child that recorded work as stalled', () => {
    expect(neverClaimedStep(runningRow({ stepCount: 1 }), SPAWNED_AT)).toBe(false);
    expect(neverClaimedStep(runningRow({ llmCalls: 1 }), SPAWNED_AT)).toBe(false);
    expect(neverClaimedStep(runningRow({ toolCalls: 2 }), SPAWNED_AT)).toBe(false);
  });

  it('stays hands off when the row carries no timestamps', () => {
    expect(neverClaimedStep(runningRow({ startedAt: null, updatedAt: null }), SPAWNED_AT)).toBe(
      false,
    );
  });
});

describe('subAgentDeadlineViolation', () => {
  it('leaves a fresh, never-claimed child alone until its first-step deadline', () => {
    expect(
      subAgentDeadlineViolation({
        elapsedMs: 30_000,
        firstStepDeadlineMs: DEFAULT_FIRST_STEP_DEADLINE_MS,
        neverClaimed: true,
      }),
    ).toBeNull();
  });

  it('reports a child that never claimed its first step', () => {
    expect(
      subAgentDeadlineViolation({
        elapsedMs: DEFAULT_FIRST_STEP_DEADLINE_MS,
        firstStepDeadlineMs: DEFAULT_FIRST_STEP_DEADLINE_MS,
        neverClaimed: true,
      }),
    ).toBe(FIRST_STEP_NEVER_STARTED);
  });

  it('never applies the first-step deadline to a child that is making progress', () => {
    expect(
      subAgentDeadlineViolation({
        elapsedMs: 10 * 60_000,
        firstStepDeadlineMs: DEFAULT_FIRST_STEP_DEADLINE_MS,
        neverClaimed: false,
      }),
    ).toBeNull();
  });

  it('honours an explicit timeout on a running child', () => {
    expect(
      subAgentDeadlineViolation({
        elapsedMs: 60_000,
        firstStepDeadlineMs: DEFAULT_FIRST_STEP_DEADLINE_MS,
        neverClaimed: false,
        timeoutMs: 60_000,
      }),
    ).toBe(SUB_AGENT_TIMEOUT);
  });

  it('prefers the diagnostic first-step reason when both deadlines are past', () => {
    expect(
      subAgentDeadlineViolation({
        elapsedMs: 600_000,
        firstStepDeadlineMs: DEFAULT_FIRST_STEP_DEADLINE_MS,
        neverClaimed: true,
        timeoutMs: 60_000,
      }),
    ).toBe(FIRST_STEP_NEVER_STARTED);
  });
});

describe('resolveFirstStepDeadlineMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to two minutes', () => {
    expect(resolveFirstStepDeadlineMs()).toBe(DEFAULT_FIRST_STEP_DEADLINE_MS);
  });

  it('reads the deployment override', () => {
    vi.stubEnv(FIRST_STEP_DEADLINE_ENV, '45000');

    expect(resolveFirstStepDeadlineMs()).toBe(45_000);
  });

  it('lets an explicit argument win over the environment', () => {
    vi.stubEnv(FIRST_STEP_DEADLINE_ENV, '45000');

    expect(resolveFirstStepDeadlineMs(30_000)).toBe(30_000);
  });

  it('clamps a nonsensical override to the floor instead of killing healthy runs', () => {
    vi.stubEnv(FIRST_STEP_DEADLINE_ENV, '1');

    expect(resolveFirstStepDeadlineMs()).toBe(MIN_FIRST_STEP_DEADLINE_MS);

    vi.unstubAllEnvs();
    expect(resolveFirstStepDeadlineMs(-5)).toBe(DEFAULT_FIRST_STEP_DEADLINE_MS);
  });
});

describe('checkSubAgentDeadline', () => {
  it('skips a child that no longer exists', async () => {
    const deps = buildDeps(null);

    await expect(
      checkSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() - 600_000 }),
    ).resolves.toBe('skipped');
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it('skips a child the normal path already settled', async () => {
    const deps = buildDeps(runningRow({ status: 'done' }));

    await expect(
      checkSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() - 600_000 }),
    ).resolves.toBe('skipped');
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it('skips a parked child — parked is not stalled', async () => {
    const deps = buildDeps(runningRow({ status: 'waiting_for_async_tool' }));

    await expect(
      checkSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() - 600_000 }),
    ).resolves.toBe('skipped');
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it('skips when the row cannot be read rather than guessing', async () => {
    const deps = buildDeps(null);
    deps.agentOperationModel.findById.mockRejectedValue(new Error('db down'));

    await expect(
      checkSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() - 600_000 }),
    ).resolves.toBe('skipped');
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it('leaves a healthy child alone', async () => {
    const deps = buildDeps(
      runningRow({ stepCount: 3, updatedAt: new Date(SPAWNED_AT + 120_000) }),
    );

    await expect(
      checkSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() - 600_000 }),
    ).resolves.toBe('alive');
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it('ends a child whose first step was never claimed', async () => {
    const deps = buildDeps(runningRow());

    await expect(
      checkSubAgentDeadline(deps, {
        operationId: 'op_child',
        spawnedAt: Date.now() - DEFAULT_FIRST_STEP_DEADLINE_MS - 1,
      }),
    ).resolves.toBe('abandoned');
    expect(deps.abandon).toHaveBeenCalledTimes(1);
    expect(deps.abandon).toHaveBeenCalledWith('op_child', FIRST_STEP_NEVER_STARTED);
  });

  it('resumes the parked parent with the abandonment reason', async () => {
    const resume = {
      errorMessage: 'Operation abandoned: subagent_first_step_never_started',
      parentOperationId: 'op_parent',
      threadId: 'thd_child',
      toolMessageId: 'msg_tool',
      userId: 'user_x',
    };
    const deps = buildDeps(runningRow());
    deps.abandon.mockResolvedValue({
      assistantMessageUpdated: true,
      finalized: false,
      found: true,
      subAgentResume: resume,
    });

    await checkSubAgentDeadline(deps, {
      operationId: 'op_child',
      spawnedAt: Date.now() - DEFAULT_FIRST_STEP_DEADLINE_MS - 1,
    });

    expect(deps.resumeParent).toHaveBeenCalledTimes(1);
    expect(deps.resumeParent).toHaveBeenCalledWith('op_child', resume);
  });

  it('does not fail the abandonment when the parent resume throws', async () => {
    const deps = buildDeps(runningRow());
    deps.abandon.mockResolvedValue({
      assistantMessageUpdated: true,
      finalized: false,
      found: true,
      subAgentResume: {
        errorMessage: 'Operation abandoned: subagent_first_step_never_started',
        parentOperationId: 'op_parent',
        threadId: 'thd_child',
        toolMessageId: 'msg_tool',
        userId: 'user_x',
      },
    });
    deps.resumeParent.mockRejectedValue(new Error('queue down'));

    await expect(
      checkSubAgentDeadline(deps, {
        operationId: 'op_child',
        spawnedAt: Date.now() - DEFAULT_FIRST_STEP_DEADLINE_MS - 1,
      }),
    ).resolves.toBe('abandoned');
  });

  it('enforces the explicit timeout on a child that is making progress', async () => {
    const deps = buildDeps(
      runningRow({ stepCount: 2, updatedAt: new Date(SPAWNED_AT + 120_000) }),
    );

    await expect(
      checkSubAgentDeadline(deps, {
        operationId: 'op_child',
        spawnedAt: Date.now() - 61_000,
        timeoutMs: 60_000,
      }),
    ).resolves.toBe('abandoned');
    expect(deps.abandon).toHaveBeenCalledTimes(1);
    expect(deps.abandon).toHaveBeenCalledWith('op_child', SUB_AGENT_TIMEOUT);
  });
});

describe('armSubAgentDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SPAWNED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends a child that never claimed its first step, in minutes rather than 30 of them', async () => {
    const deps = buildDeps(runningRow());

    armSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() });

    await vi.advanceTimersByTimeAsync(DEFAULT_FIRST_STEP_DEADLINE_MS - 1);
    expect(deps.abandon).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.abandon).toHaveBeenCalledTimes(1);
    expect(deps.abandon).toHaveBeenCalledWith('op_child', FIRST_STEP_NEVER_STARTED);
    // One-shot: no timer is left behind after the child was retired.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a healthy child completely untouched when no timeout was given', async () => {
    const deps = buildDeps(
      runningRow({ stepCount: 2, updatedAt: new Date(SPAWNED_AT + 60_000) }),
    );

    armSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() });

    await vi.advanceTimersByTimeAsync(DEFAULT_FIRST_STEP_DEADLINE_MS);
    expect(deps.abandon).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arms once for the explicit timeout and then ends the run', async () => {
    const timeoutMs = 300_000;
    const deps = buildDeps(
      runningRow({ stepCount: 2, updatedAt: new Date(SPAWNED_AT + 60_000) }),
    );

    armSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now(), timeoutMs });

    await vi.advanceTimersByTimeAsync(DEFAULT_FIRST_STEP_DEADLINE_MS);
    expect(deps.abandon).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(timeoutMs - DEFAULT_FIRST_STEP_DEADLINE_MS);
    expect(deps.abandon).toHaveBeenCalledTimes(1);
    expect(deps.abandon).toHaveBeenCalledWith('op_child', SUB_AGENT_TIMEOUT);
  });

  it('can be cancelled', async () => {
    const deps = buildDeps(runningRow());
    const cancel = armSubAgentDeadline(deps, { operationId: 'op_child', spawnedAt: Date.now() });

    cancel();
    await vi.advanceTimersByTimeAsync(DEFAULT_FIRST_STEP_DEADLINE_MS * 2);

    expect(deps.abandon).not.toHaveBeenCalled();
  });
});
