/**
 * Hatchet publishes this process has started and Hatchet has not answered yet.
 * Some callers fire a publish without awaiting it (hook observations, the
 * after-tool-call dispatch), so draining waits on this set rather than on the
 * callers: a delivery counts once Hatchet has accepted it.
 *
 * Process-wide, like the step drain: route handlers publish from their own
 * bundle, while the drain that waits for them runs in the instrumentation one.
 */
const key = Symbol.for('lobehub.hatchetPendingPublishes');
const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
const pending = (globals[key] ??= new Set<Promise<unknown>>()) as Set<Promise<unknown>>;

export const trackPublish = <T>(publish: Promise<T>): Promise<T> => {
  pending.add(publish);
  const settle = () => pending.delete(publish);
  publish.then(settle, settle);
  return publish;
};

export const pendingPublishCount = (): number => pending.size;

/** Resolves once nothing is pending, including publishes started while it waited. */
export const settlePendingPublishes = async (): Promise<void> => {
  while (pending.size > 0) await Promise.allSettled(pending);
};
