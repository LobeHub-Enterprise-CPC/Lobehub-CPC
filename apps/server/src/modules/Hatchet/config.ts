import { appEnv } from '@/envs/app';

/** Queue mode (AGENT_RUNTIME_MODE=queue) delivers everything through Hatchet. */
export const isHatchetDeliveryEnabled = (): boolean => appEnv.enableQueueAgentRuntime === true;

export const AGENT_STEP_TASK = 'cpc-agent-step';
export const DELIVERY_TASK = 'cpc-delivery';
/**
 * Memory workflow deliveries. Only the memory worker process serves this task, so every
 * queue-mode deployment runs one; the web pods never take memory work.
 */
export const MEMORY_DELIVERY_TASK = 'cpc-memory-delivery';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Timing contract. The runtime keeps an operation's Redis state for
 * `AGENT_RUNTIME_STATE_TTL_SECONDS` and every step attempt refreshes it, so the
 * longest wait between two attempts (queueing + one attempt + one retry wait)
 * has to stay inside that (`timing.test.ts`).
 *
 * A step attempt is one `/run` invocation: steps keep starting inline for
 * `AGENT_INLINE_STEP_DEADLINE_MS` (450s), and the last one runs to completion
 * with no in-process bound. Its length is therefore set by the slowest model
 * call, not by the runtime: production measured 2,298s (38 min) for a single
 * call between 2026-10-03 and 11-02. Timing out an attempt that is still
 * running only redelivers it behind the step lock, and an attempt killed by
 * the platform repeats a paid model call, so the attempt timeout, the pod
 * termination grace (3600s) and the lock-conflict wait all cover that length
 * instead of cutting it.
 */
export const HATCHET_TIMING = {
  /** Same dedup window as QStash. */
  dedupTtlMs: 10 * MINUTE,
  /** Covers the longest delivery attempt, a workflow step's (`workflowDeliveryHttpTimeoutMs`). */
  deliveryExecutionTimeoutMs: 65 * MINUTE,
  /**
   * Per-attempt HTTP timeout of a direct delivery published without one. QStash
   * then allows the plan maximum, and some receivers (goal advance, widget
   * runs, task ticks) work for minutes: a short default would retry them while
   * the first attempt is still running.
   */
  deliveryHttpTimeoutMs: 15 * MINUTE,
  /** Direct deliveries carry their whole request and have no reaper behind them. */
  deliveryQueueTimeoutMs: 24 * HOUR,
  /** A step run still queued after this fails instead of starting against expired state. */
  queueTimeoutMs: 60 * MINUTE,
  /** Upper bound for any retry wait, whatever Retry-After or `retryDelay` asked for. */
  retryWaitCapMs: 30 * MINUTE,
  stepExecutionTimeoutMs: 65 * MINUTE,
  /** One `/run` invocation: 450s of inline steps plus the slowest single step, with margin. */
  stepHttpTimeoutMs: 60 * MINUTE,
  /**
   * Per-attempt HTTP timeout of a workflow delivery. A delivery runs steps for up to its 5-minute
   * budget and then always finishes the step in progress, which can be a single slow model call
   * (memory extraction of one conversation segment), so like a step attempt it has to cover the
   * slowest call. A shorter timeout only redelivers the attempt into the run lock (HTTP 409)
   * until its retries run out while the first attempt is still working.
   */
  workflowDeliveryHttpTimeoutMs: 60 * MINUTE,
} as const;

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value;
};

/** Per-worker scheduling capacity. Scale workers/resources rather than imposing tenant quotas. */
export const getHatchetCapacity = () => ({
  deliverySlots: positiveInt('HATCHET_DELIVERY_SLOTS', 50),
  memorySlots: positiveInt('HATCHET_MEMORY_SLOTS', 20),
  stepSlots: positiveInt('HATCHET_STEP_SLOTS', 50),
});
