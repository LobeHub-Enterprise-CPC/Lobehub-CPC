import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscoveryAdmission, withDiscoveryDeadline } from './admission';

const block = () => Promise.withResolvers<void>();
afterEach(() => vi.useRealTimers());
describe('discovery admission', () => {
  it('bounds active work to four, queues sixteen, and rejects overload', async () => {
    const gate = new DiscoveryAdmission();
    const released = block();
    let running = 0;
    let maximum = 0;
    const work = () =>
      gate.run(new AbortController().signal, async () => {
        running += 1;
        maximum = Math.max(maximum, running);
        await released.promise;
        running -= 1;
      });
    const jobs = Array.from({ length: 20 }, work);
    await expect(work()).rejects.toMatchObject({ status: 503 });
    expect(running).toBe(4);
    released.resolve();
    await Promise.all(jobs);
    expect(maximum).toBe(4);
  });

  it('removes timed out and disconnected waiters without running their database task', async () => {
    vi.useFakeTimers();
    const gate = new DiscoveryAdmission();
    const released = block();
    const active = Array.from({ length: 4 }, () =>
      gate.run(new AbortController().signal, () => released.promise),
    );
    const work = vi.fn();
    const controller = new AbortController();
    const cancelled = expect(gate.run(controller.signal, work)).rejects.toMatchObject({
      status: 503,
    });
    controller.abort();
    const timed = expect(gate.run(new AbortController().signal, work)).rejects.toMatchObject({
      status: 503,
    });
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.all([cancelled, timed]);
    released.resolve();
    await Promise.all(active);
    expect(work).not.toHaveBeenCalled();
  });

  it('includes connection and queue time in the six-second deadline and cancels its signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const task = withDiscoveryDeadline(new AbortController().signal, async (s) => {
      signal = s;
      await new Promise(() => undefined);
    });
    const rejected = expect(task).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });
});
