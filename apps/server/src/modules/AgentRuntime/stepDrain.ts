/**
 * Agent steps executing in this process, and whether the process is shutting down.
 *
 * In local runtime mode a step runs in the process that scheduled it, and the
 * next step is queued in-process too. When the process is told to stop
 * (SIGTERM on a rollout or scale-down), the tenant process lease waits for the
 * steps already running here before it deregisters, because they still write
 * through that lease; queued steps that have not started are dropped. The run
 * then stops refreshing its liveness lease, and the stale-operation cron sweep
 * redrives it from its saved state on an instance that keeps running. The
 * platform's grace period (SIGKILL) bounds the wait; a step killed there is
 * redriven the same way.
 */
const running = new Set<Promise<unknown>>();
let draining = false;

export const isDrainingAgentSteps = (): boolean => draining;

export const trackAgentStep = <T>(step: Promise<T>): Promise<T> => {
  running.add(step);
  const forget = () => running.delete(step);
  step.then(forget, forget);
  return step;
};

/** Stops starting queued steps, then resolves once every step running here has settled. */
export const drainAgentSteps = async (): Promise<void> => {
  draining = true;
  while (running.size > 0) await Promise.allSettled(running);
};
