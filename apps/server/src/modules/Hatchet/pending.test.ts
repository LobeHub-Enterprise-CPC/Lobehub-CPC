// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pending Hatchet publishes', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for('lobehub.hatchetPendingPublishes'));
  });

  it('are shared across module instances, so the drain sees publishes from route bundles', async () => {
    // Route handlers publish from their own bundle; the drain runs in the instrumentation bundle.
    vi.resetModules();
    const route = await import('./pending');
    vi.resetModules();
    const instrumentation = await import('./pending');
    const publish = deferred();

    void route.trackPublish(publish.promise);
    expect(instrumentation.pendingPublishCount()).toBe(1);

    let settled = false;
    const settling = instrumentation.settlePendingPublishes().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    publish.resolve();
    await settling;
    expect(instrumentation.pendingPublishCount()).toBe(0);
    expect(route.pendingPublishCount()).toBe(0);
  });

  it('forgets a publish once Hatchet has answered, even with an error', async () => {
    vi.resetModules();
    const pending = await import('./pending');

    const failed = pending.trackPublish(Promise.reject(new Error('engine unavailable')));
    expect(pending.pendingPublishCount()).toBe(1);

    await expect(failed).rejects.toThrow('engine unavailable');
    await pending.settlePendingPublishes();
    expect(pending.pendingPublishCount()).toBe(0);
  });
});
