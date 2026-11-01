// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as StepDrain from './stepDrain';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('drainAgentSteps', () => {
  let drain: typeof StepDrain;

  beforeEach(async () => {
    Reflect.deleteProperty(globalThis, Symbol.for('lobehub.agentStepDrain'));
    vi.resetModules();
    drain = await import('./stepDrain');
  });

  it('shares participants, running steps and draining state across module instances', async () => {
    const stop = vi.fn(async () => {});
    const step = deferred();
    drain.registerDrainParticipant({ stop });
    drain.trackAgentStep(step.promise);
    vi.resetModules();
    const other = await import('./stepDrain');
    let done = false;
    const draining = other.drainAgentSteps().then(() => {
      done = true;
    });
    expect(drain.isDrainingAgentSteps()).toBe(true);
    await tick();
    expect(stop).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    step.resolve();
    await draining;
  });

  it('waits for running steps and stopping producers, then reports draining', async () => {
    const step = deferred();
    const stop = deferred();
    drain.trackAgentStep(step.promise);
    drain.registerDrainParticipant({ stop: () => stop.promise });

    let done = false;
    const drained = drain.drainAgentSteps().then(() => {
      done = true;
    });

    expect(drain.isDrainingAgentSteps()).toBe(true);
    step.resolve();
    await tick();
    expect(done).toBe(false);
    stop.resolve();
    await drained;
    expect(done).toBe(true);
  });

  it('waits for work a producer leaves behind after the drain started', async () => {
    // A step still running when SIGTERM arrives hands work to the host only as
    // it finishes; a pending set that was empty at drain start must not end it.
    const pending = new Set<Promise<void>>();
    drain.registerDrainParticipant({
      pending: () => pending.size,
      settle: async () => {
        while (pending.size > 0) await Promise.allSettled(pending);
      },
    });
    const step = deferred();
    const leftBehind = deferred();
    drain.trackAgentStep(
      step.promise.then(() => {
        const work = leftBehind.promise.then(() => {
          pending.delete(work);
        });
        pending.add(work);
      }),
    );

    let done = false;
    const drained = drain.drainAgentSteps().then(() => {
      done = true;
    });
    await tick();
    step.resolve();
    await tick();
    expect(done).toBe(false);
    leftBehind.resolve();
    await drained;
    expect(done).toBe(true);
  });

  it('keeps settling until a whole round adds nothing new', async () => {
    let pending = 2;
    const settle = vi.fn(async () => {
      pending -= 1;
    });
    drain.registerDrainParticipant({ pending: () => pending, settle });

    await drain.drainAgentSteps();

    expect(pending).toBe(0);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('ignores a participant that was unregistered', async () => {
    const stop = vi.fn(async () => {});
    const unregister = drain.registerDrainParticipant({ stop });
    unregister();

    await drain.drainAgentSteps();

    expect(stop).not.toHaveBeenCalled();
  });
});
