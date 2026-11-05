import { describe, expect, it, vi } from 'vitest';

import { createStallDetector, noteActivity, snapshotActivities, withActivity } from '../index';

describe('RuntimeActivity', () => {
  it('lists what is running, with the details work added along the way', async () => {
    let seen: ReturnType<typeof snapshotActivities> = [];

    await withActivity('workflow', 'process-user-topics', { runId: 'wfr_1' }, async () => {
      noteActivity({ phase: 'retrieval', topicId: 'tpc_1' });
      seen = snapshotActivities();
    });

    expect(seen).toEqual([
      expect.objectContaining({
        kind: 'workflow',
        label: 'process-user-topics',
        phase: 'retrieval',
        runId: 'wfr_1',
        topicId: 'tpc_1',
      }),
    ]);
    expect(snapshotActivities()).toEqual([]);
  });

  it('ignores details noted outside any activity', () => {
    expect(() => noteActivity({ phase: 'x' })).not.toThrow();
    expect(snapshotActivities()).toEqual([]);
  });

  it('reports a blocked event loop with the work that was running', () => {
    let now = 0;
    const log = vi.fn();
    const detector = createStallDetector({
      activities: () => [{ ageMs: 20_000, kind: 'workflow', label: 'process-user-topics' }],
      intervalMs: 500,
      log,
      now: () => now,
      thresholdMs: 1000,
    });

    now = 500;
    detector.tick();
    expect(log).not.toHaveBeenCalled();

    // The timer meant for 500ms later fires 17s late: the loop was blocked in between.
    now = 18_000;
    detector.tick();

    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      activities: [{ ageMs: 20_000, kind: 'workflow', label: 'process-user-topics' }],
      blockedMs: 17_000,
      event: 'event_loop.stalled',
    });
  });

  it('still names work that finished inside the blocked stretch', async () => {
    let now = 1000;
    const clock = () => now;

    await withActivity(
      'workflow',
      'quick-but-blocking',
      {},
      async () => {
        now = 9000;
      },
      clock,
    );

    // Ended 1s ago: within a 10s stall it was the one holding the loop.
    now = 10_000;
    const named = (endedWithinMs: number) =>
      snapshotActivities({ endedWithinMs, now: clock }).filter(
        (activity) => activity.label === 'quick-but-blocking',
      );
    expect(named(10_000)).toEqual([expect.objectContaining({ ended: true })]);
    expect(named(500)).toEqual([]);
  });
});
