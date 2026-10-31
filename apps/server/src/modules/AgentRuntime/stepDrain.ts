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
const key = Symbol.for('lobehub.agentStepDrain');
const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
const state = (globals[key] ??= {
  draining: false,
  participants: new Set<DrainParticipant>(),
  running: new Set<Promise<unknown>>(),
}) as { draining: boolean; participants: Set<DrainParticipant>; running: Set<Promise<unknown>> };
const { participants, running } = state;

/**
 * Something else that has to be quiet before the lease deregisters (the
 * Hatchet workers, post-response work, publishes in flight). Drain runs every
 * `stop` once, alongside the running steps, then waits until no participant
 * reports pending work.
 */
export interface DrainParticipant {
  /** Number of things still in flight; drain only finishes once every participant reports 0. */
  pending?: () => number;
  /** Waits for what is pending now. Work added while it waits is picked up by the next round. */
  settle?: () => Promise<void>;
  /** Stops taking new work and resolves once work already accepted here has finished. */
  stop?: () => Promise<void>;
}

export const isDrainingAgentSteps = (): boolean => state.draining;

export const trackAgentStep = <T>(step: Promise<T>): Promise<T> => {
  running.add(step);
  const forget = () => running.delete(step);
  step.then(forget, forget);
  return step;
};

export const registerDrainParticipant = (participant: DrainParticipant): (() => void) => {
  participants.add(participant);
  return () => participants.delete(participant);
};

const settleRunningSteps = async () => {
  while (running.size > 0) await Promise.allSettled(running);
};

const quiet = () =>
  running.size === 0 && [...participants].every((participant) => !participant.pending?.());

/**
 * Stops starting queued steps, then resolves once every step running here has
 * settled. Producers stop first (they can still hand work to the host or
 * publish while they finish); only then is everything they left behind waited
 * for, round after round, until a whole round adds nothing new.
 */
export const drainAgentSteps = async (): Promise<void> => {
  state.draining = true;
  await Promise.allSettled([
    settleRunningSteps(),
    ...[...participants].map((participant) => participant.stop?.()),
  ]);
  while (!quiet()) {
    await Promise.allSettled([
      settleRunningSteps(),
      ...[...participants].map((participant) => participant.settle?.()),
    ]);
  }
};
