import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/**
 * What this process is working on right now, so a stalled event loop or a lease self-fence can
 * name the work that held it instead of leaving only a restart behind.
 */
export type ActivityDetail = Record<string, string | number | boolean | undefined>;

interface Activity {
  detail: ActivityDetail;
  endedAt?: number;
  kind: string;
  label: string;
  startedAt: number;
}

export interface ActivitySnapshot extends ActivityDetail {
  ageMs: number;
  kind: string;
  label: string;
}

type Clock = () => number;

const RECENT_LIMIT = 50;

const storage = new AsyncLocalStorage<Activity>();
const live = new Set<Activity>();
/** Recently ended activities: sync work can finish in the same task that blocked the loop. */
const recent: Activity[] = [];

const defaultClock: Clock = () => performance.now();

export const withActivity = async <T>(
  kind: string,
  label: string,
  detail: ActivityDetail,
  fn: () => Promise<T>,
  now: Clock = defaultClock,
): Promise<T> => {
  const activity: Activity = { detail: { ...detail }, kind, label, startedAt: now() };
  live.add(activity);
  try {
    return await storage.run(activity, fn);
  } finally {
    live.delete(activity);
    activity.endedAt = now();
    recent.push(activity);
    if (recent.length > RECENT_LIMIT) recent.shift();
  }
};

/** Adds details (user, topic, phase…) to the activity the caller runs in; a no-op outside one. */
export const noteActivity = (detail: ActivityDetail) => {
  const activity = storage.getStore();
  if (activity) Object.assign(activity.detail, detail);
};

export const snapshotActivities = ({
  endedWithinMs = 0,
  now = defaultClock,
}: { endedWithinMs?: number; now?: Clock } = {}): ActivitySnapshot[] => {
  const at = now();
  const toSnapshot = (activity: Activity, ended: boolean): ActivitySnapshot => ({
    ...activity.detail,
    ageMs: Math.round(at - activity.startedAt),
    ...(ended ? { ended: true } : {}),
    kind: activity.kind,
    label: activity.label,
  });

  return [
    ...[...live].map((activity) => toSnapshot(activity, false)),
    ...recent
      .filter((activity) => endedWithinMs > 0 && at - (activity.endedAt ?? at) <= endedWithinMs)
      .map((activity) => toSnapshot(activity, true)),
  ];
};

interface StallDetectorOptions {
  activities?: (blockedMs: number) => ActivitySnapshot[];
  intervalMs?: number;
  log?: (line: string) => void;
  now?: Clock;
  thresholdMs?: number;
}

/**
 * Notices a blocked event loop from how late its own timer fires. `tick` runs on that timer; a
 * stall is reported after the loop frees up, together with the work that was running.
 */
export const createStallDetector = ({
  activities = (blockedMs) => snapshotActivities({ endedWithinMs: blockedMs }),
  intervalMs = 500,
  log = (line) => console.warn(line),
  now = defaultClock,
  thresholdMs = 1000,
}: StallDetectorOptions = {}) => {
  let last = now();

  return {
    intervalMs,
    tick() {
      const at = now();
      const blockedMs = Math.round(at - last - intervalMs);
      last = at;
      if (blockedMs < thresholdMs) return;
      log(
        JSON.stringify({
          activities: activities(blockedMs),
          blockedMs,
          event: 'event_loop.stalled',
        }),
      );
    },
  };
};

let started = false;

/** Starts the process-wide stall detector once. */
export const startStallDetector = (options?: StallDetectorOptions) => {
  if (started) return;
  started = true;
  const detector = createStallDetector(options);
  setInterval(() => detector.tick(), detector.intervalMs).unref?.();
};
