import { appEnv } from '@/envs/app';

/** Queue-mode deliveries go through Hatchet (AGENT_RUNTIME_MODE=queue + AGENT_RUNTIME_DELIVERY=hatchet). */
export const isHatchetDeliveryEnabled = (): boolean =>
  appEnv.enableQueueAgentRuntime === true && appEnv.enableHatchetAgentDelivery === true;

export const AGENT_STEP_TASK = 'cpc-agent-step';
export const DELIVERY_TASK = 'cpc-delivery';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Timing contract. The runtime keeps an operation's Redis state for 2h and
 * every step attempt refreshes it, so the longest wait between two attempts
 * (queueing + one attempt + one retry wait) has to stay well inside that.
 */
export const HATCHET_TIMING = {
  /** Same dedup window as QStash. */
  dedupTtlMs: 10 * MINUTE,
  deliveryExecutionTimeoutMs: 20 * MINUTE,
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
  stepExecutionTimeoutMs: 20 * MINUTE,
  stepHttpTimeoutMs: 15 * MINUTE,
} as const;

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value;
};

/** Worker capacity and per-tenant concurrency; the defaults are starting points to be load-tested. */
export const getHatchetCapacity = () => ({
  deliverySlots: positiveInt('HATCHET_DELIVERY_SLOTS', 50),
  stepSlots: positiveInt('HATCHET_STEP_SLOTS', 50),
  tenantDeliveryMaxRuns: positiveInt('HATCHET_TENANT_DELIVERY_MAX_RUNS', 64),
  tenantStepMaxRuns: positiveInt('HATCHET_TENANT_STEP_MAX_RUNS', 32),
});
