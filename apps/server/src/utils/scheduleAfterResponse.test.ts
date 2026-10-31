// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  after,
  afterUnscoped,
  flushScheduledWork,
  pendingHostWorkCount,
  runWithScheduledWorkScope,
  settleHostWork,
} from './scheduleAfterResponse';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('scheduled work scope', () => {
  it('starts deferred work immediately and waits for it on flush', async () => {
    const events: string[] = [];

    await runWithScheduledWorkScope(async () => {
      after(async () => {
        events.push('work started');
        await sleep(20);
        events.push('work finished');
      });
      events.push('scheduled');

      await flushScheduledWork();
      events.push('flushed');
    });

    expect(events).toEqual(['work started', 'scheduled', 'work finished', 'flushed']);
  });

  it('drains work that deferred work schedules in turn', async () => {
    const events: string[] = [];

    await runWithScheduledWorkScope(async () => {
      after(async () => {
        await sleep(5);
        after(async () => {
          await sleep(5);
          events.push('nested finished');
        });
      });

      await flushScheduledWork();
      events.push('flushed');
    });

    expect(events).toEqual(['nested finished', 'flushed']);
  });

  it('stops waiting at the timeout and leaves the work running', async () => {
    let finished = false;

    await runWithScheduledWorkScope(async () => {
      after(async () => {
        await sleep(80);
        finished = true;
      });

      const startedAt = Date.now();
      await expect(flushScheduledWork({ timeoutMs: 10 })).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(60);
      expect(finished).toBe(false);
    });

    await sleep(100);
    expect(finished).toBe(true);
  });

  it('does not let a failing task reject the flush', async () => {
    await runWithScheduledWorkScope(async () => {
      after(async () => {
        throw new Error('boom');
      });

      await expect(flushScheduledWork()).resolves.toBe(true);
    });
  });

  it('reports a drained flush within the timeout as settled', async () => {
    await runWithScheduledWorkScope(async () => {
      after(async () => {
        await sleep(5);
      });

      await expect(flushScheduledWork({ timeoutMs: 1000 })).resolves.toBe(true);
    });
  });

  it('does not wait for unfinished work when the scope ends', async () => {
    let finished = false;

    const startedAt = Date.now();
    await runWithScheduledWorkScope(async () => {
      after(async () => {
        await sleep(80);
        finished = true;
      });
    });

    expect(Date.now() - startedAt).toBeLessThan(60);
    expect(finished).toBe(false);
    await sleep(100);
    expect(finished).toBe(true);
  });

  it('captures work deferred from a stream callback created inside the scope', async () => {
    // Model responses settle their budget hold from a TransformStream flush()
    // callback. The fix for inline agent steps depends on that work still being
    // tied to the scope by the time the stream finishes.
    const events: string[] = [];

    await runWithScheduledWorkScope(async () => {
      const stream = new Response('data: 1\n\ndata: 2\n\n').body!.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async flush() {
            after(async () => {
              await sleep(20);
              events.push('settled');
            });
          },
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        }),
      );

      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // drain the stream so flush() runs
      }
      events.push('stream done');

      await flushScheduledWork();
      events.push('flushed');
    });

    expect(events).toEqual(['stream done', 'settled', 'flushed']);
  });

  it('is a no-op outside a scope', async () => {
    await expect(flushScheduledWork()).resolves.toBe(true);
  });

  it('does not capture unscoped work, so a long refresh never holds a step-boundary flush', async () => {
    let finished = false;

    await runWithScheduledWorkScope(async () => {
      afterUnscoped(async () => {
        await sleep(80);
        finished = true;
      });

      const startedAt = Date.now();
      // Settled: the scope has nothing pending, the unscoped work is the host's.
      await expect(flushScheduledWork({ timeoutMs: 10 })).resolves.toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(60);
      expect(finished).toBe(false);
    });

    await sleep(100);
    expect(finished).toBe(true);
  });
});

describe('host work tracking', () => {
  it('counts work handed to the host until it finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterUnscoped(async () => {
      await gate;
    });

    expect(pendingHostWorkCount()).toBe(1);
    let settled = false;
    const settling = settleHostWork().then(() => {
      settled = true;
    });
    await sleep(5);
    expect(settled).toBe(false);

    release();
    await settling;
    expect(pendingHostWorkCount()).toBe(0);
  });

  it('tracks what a scope still has running when it returns', async () => {
    // The scope hands leftovers to the host on exit; a drain started before
    // that moment must still see them.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await runWithScheduledWorkScope(async () => {
      after(async () => {
        await gate;
      });
    });

    expect(pendingHostWorkCount()).toBe(1);
    release();
    await settleHostWork();
    expect(pendingHostWorkCount()).toBe(0);
  });

  it('settles failing host work too', async () => {
    afterUnscoped(async () => {
      throw new Error('boom');
    });

    await settleHostWork();
    expect(pendingHostWorkCount()).toBe(0);
  });
});
