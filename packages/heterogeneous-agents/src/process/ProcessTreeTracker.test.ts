import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { type ProcessRow, ProcessTreeTracker } from './ProcessTreeTracker';

const child = { pid: 10, exitCode: null, signalCode: null } as ChildProcess;
const root = { pid: 10, parent: 1, identity: 'root-start' };
const descendant = { pid: 20, parent: 10, identity: 'child-start' };

describe('Process tree safety', () => {
  it('coalesces overlapping observations instead of forking overlapping ps processes', async () => {
    let finish!: (rows: ProcessRow[]) => void;
    const read = vi.fn(
      () =>
        new Promise<ProcessRow[]>((resolve) => {
          finish = resolve;
        }),
    );
    const tracker = new ProcessTreeTracker(() => child, read);
    const a = tracker.track(),
      b = tracker.track();
    expect(read).toHaveBeenCalledTimes(1);
    finish([root]);
    await Promise.all([a, b]);
  });
  it('tracks reparented children but never signals a reused unrelated PID', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce([root, descendant])
      .mockResolvedValueOnce([
        { ...descendant, parent: 1 },
        { ...root, identity: 'unrelated-start' },
      ])
      .mockResolvedValueOnce([]);
    let running = child;
    const signal = vi.fn();
    const tracker = new ProcessTreeTracker(() => running, read, signal);
    const stopped = await tracker.terminate(() => {
      running = { ...child, exitCode: 0 } as ChildProcess;
    });
    expect(stopped).toBe(true);
    expect(signal).toHaveBeenCalledWith(20, 'SIGTERM');
    expect(signal).not.toHaveBeenCalledWith(10, expect.anything());
  });
  it('does not clear uncertainty after a missed observation just because ps later succeeds', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('ps unavailable')).mockResolvedValue([]);
    const tracker = new ProcessTreeTracker(() => undefined, read);
    await tracker.track();
    expect(await tracker.terminate(() => {})).toBe(false);
  });
});
