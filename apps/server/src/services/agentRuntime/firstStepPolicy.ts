/**
 * How long a freshly spawned sub-operation may stay without ever claiming its
 * first step before the spawn-side deadline retires it.
 *
 * A `callSubAgent` child starts its run with a single fire-and-forget queue
 * delivery (`createOperation` → `scheduleMessage`). When that delivery never
 * executes — the creating process is draining, the gateway version check
 * refuses the step, the tenant is deferred, the local queue's `setTimeout`
 * chain is lost with the process — the child row stays `running` with no step,
 * no LLM call and no error, while its parent sits parked on the `callSubAgent`
 * tool call. Nothing in the child's own lifecycle notices: the stale-operation
 * sweep only resumes runs it can resume, and the gateway's inactivity watchdog
 * does not act until 30 minutes have passed. Observed in production
 * (2026-10-26, tenant citic-tel): child created 06:52:41, zero steps, abandoned
 * at 07:22:42 with an empty `error` column, parent dead ten minutes earlier.
 *
 * A healthy child claims step 0 within milliseconds of being created (the queue
 * delay is 50ms), and a step that IS running refreshes its durable lease while
 * it holds the step lock (`startStepLockHeartbeat`: lock refresh every 30s,
 * durable `updated_at` touch every 90s). Three minutes therefore leaves a full
 * extra heartbeat of slack over the slowest legitimate first step, while still
 * ending a lost dispatch ~27 minutes before the watchdog would.
 */
export const DEFAULT_FIRST_STEP_DEADLINE_MS = 3 * 60_000;

/** Floor for any configured deadline, so a typo cannot kill healthy runs. */
export const MIN_FIRST_STEP_DEADLINE_MS = 5_000;

/**
 * Slack on the creation write: `started_at` and the row's first `updated_at`
 * land a few milliseconds apart, and a row stays "untouched" until the step
 * lock starts heartbeating (the first durable touch lands at 90s).
 */
export const CLAIM_SETTLE_MS = 5_000;

/** Optional deployment override for {@link DEFAULT_FIRST_STEP_DEADLINE_MS}. */
export const FIRST_STEP_DEADLINE_ENV = 'SUBAGENT_FIRST_STEP_DEADLINE_MS';

/**
 * How old a never-claimed child must be before the DURABLE sweep retires it.
 *
 * Deliberately longer than the spawn-side deadline: the sweep cannot tell a
 * lost delivery from a *deferred* one — a tenant that is briefly unavailable
 * re-queues its step every `TENANT_DEFERRED_STEP_RETRY_MS` (30s) — so it waits
 * a few retry rungs before declaring the delivery lost. Still far below the
 * gateway's 30-minute watchdog and below the parked parent's own 10-minute
 * inactivity limit, which is the deadline that actually hurts the user.
 */
export const DEFAULT_FIRST_STEP_SWEEP_MS = 6 * 60_000;

/** Optional deployment override for {@link DEFAULT_FIRST_STEP_SWEEP_MS}. */
export const FIRST_STEP_SWEEP_ENV = 'SUBAGENT_FIRST_STEP_SWEEP_MS';

/**
 * The child was created but never claimed a step: its first-step delivery was
 * lost. Nothing ran, so ending it loses no work.
 */
export const FIRST_STEP_NEVER_STARTED = 'subagent_first_step_never_started';

/** The caller's explicit `callSubAgent.timeout` elapsed while the child was live. */
export const SUB_AGENT_TIMEOUT = 'subagent_timeout';

const resolvePositiveMs = (override: number | undefined, envName: string, fallback: number) => {
  const requested =
    typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : Number(process.env[envName]);

  if (!Number.isFinite(requested) || requested <= 0) return fallback;

  return Math.max(MIN_FIRST_STEP_DEADLINE_MS, Math.floor(requested));
};

export const resolveFirstStepDeadlineMs = (override?: number): number =>
  resolvePositiveMs(override, FIRST_STEP_DEADLINE_ENV, DEFAULT_FIRST_STEP_DEADLINE_MS);

/**
 * The durable window, never shorter than the spawn-side deadline: a sweep that
 * retired children faster than the in-process guard would only ever race it.
 */
export const resolveFirstStepSweepMs = (override?: number): number =>
  Math.max(
    resolveFirstStepDeadlineMs(),
    resolvePositiveMs(override, FIRST_STEP_SWEEP_ENV, DEFAULT_FIRST_STEP_SWEEP_MS),
  );

/**
 * Whether a live child has demonstrably never claimed its first step.
 *
 * `step_count` alone is not enough: it counts COMPLETED steps, so a step 0 that
 * is legitimately in flight still reads 0. The durable lease is what separates
 * the two — a step holding the step lock touches `updatedAt` every
 * `STEP_LOCK_HEARTBEAT_MS * DURABLE_LEASE_HEARTBEAT_EVERY_TICKS` (90s), while a
 * row whose delivery was dropped keeps the timestamp of its creation write and
 * nothing else. Recorded LLM/tool calls are honoured too, so any child that got
 * work done is never treated as stalled even if its lease reads stale.
 *
 * Unknown timestamps are treated as "alive": both callers only ever act on a
 * positive signal, because abandoning a run is irreversible.
 */
export const neverClaimedStep = (
  operation: {
    llmCalls?: number | null;
    startedAt?: Date | string | null;
    stepCount?: number | null;
    toolCalls?: number | null;
    updatedAt?: Date | string | null;
  },
  fallbackStartedAtMs: number,
): boolean => {
  if ((operation.stepCount ?? 0) > 0) return false;
  if ((operation.llmCalls ?? 0) > 0 || (operation.toolCalls ?? 0) > 0) return false;
  if (!operation.updatedAt) return false;

  const startedAtMs = operation.startedAt
    ? new Date(operation.startedAt).getTime()
    : fallbackStartedAtMs;
  if (!Number.isFinite(startedAtMs)) return false;

  const lastWriteMs = new Date(operation.updatedAt).getTime();
  if (!Number.isFinite(lastWriteMs)) return false;

  return lastWriteMs <= startedAtMs + CLAIM_SETTLE_MS;
};

/**
 * Which deadline (if any) a live child has overrun.
 *
 * Split out from the DB read so the policy is testable on its own: a child that
 * never claimed a step is judged by the first-step deadline, a child that is
 * making progress only by the caller's explicit timeout.
 */
export const subAgentDeadlineViolation = (params: {
  elapsedMs: number;
  firstStepDeadlineMs: number;
  /** Derived by {@link neverClaimedStep} from the durable row. */
  neverClaimed: boolean;
  timeoutMs?: number;
}): string | null => {
  const { elapsedMs, firstStepDeadlineMs, neverClaimed, timeoutMs } = params;

  // Prefer the diagnostic reason when both deadlines are past.
  if (neverClaimed && elapsedMs >= firstStepDeadlineMs) return FIRST_STEP_NEVER_STARTED;
  if (timeoutMs && timeoutMs > 0 && elapsedMs >= timeoutMs) return SUB_AGENT_TIMEOUT;

  return null;
};
