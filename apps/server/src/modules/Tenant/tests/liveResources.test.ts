import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '../errors';
import { guardTenantStream, TenantLiveResources } from '../liveResources';

const INTERVAL = 1000;
const CHECK_TIMEOUT = 200;
const ACTION_TIMEOUT = 300;
const FROZEN = () => new TenantGateError('TENANT_FROZEN');

describe('TenantLiveResources', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const refused = new Map<string, Error>();
    const check = vi.fn(async (tenantId: string) => {
      const error = refused.get(tenantId);
      if (error) throw error;
    });
    const live = new TenantLiveResources(check, INTERVAL, CHECK_TIMEOUT, ACTION_TIMEOUT);
    return { check, live, refused };
  };

  it('closes only the suspended tenant and drops resources that cannot reopen', async () => {
    const { live } = setup();
    const a = vi.fn();
    const b = vi.fn();
    live.bind('a', { close: a });
    live.bind('b', { close: b });

    await live.suspend('a', FROZEN());

    expect(a).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_FROZEN' }));
    expect(b).not.toHaveBeenCalled();
    expect(live.size('a')).toBe(0);
    expect(live.size('b')).toBe(1);
  });

  it('does not acknowledge cancellation until the actual work settles', async () => {
    const { live } = setup();
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => (finish = resolve));
    const close = vi.fn();
    live.bind('a', { close, settled });
    let acknowledged = false;
    const stopping = live.suspend('a', FROZEN()).then(() => (acknowledged = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(false);
    expect(live.size('a')).toBe(1);
    finish();
    await stopping;
    expect(live.size('a')).toBe(0);
  });

  it('signals all dependent work before waiting for any one resource to settle', async () => {
    const { live } = setup();
    let finish!: () => void;
    const childDone = new Promise<void>((resolve) => (finish = resolve));
    live.bind('a', { close: () => childDone });
    live.bind('a', { close: () => finish() });
    const stopping = live.suspend('a', FROZEN());
    const result = stopping.then(
      () => true,
      () => false,
    );
    await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT);
    expect(await result).toBe(true);
    expect(live.size('a')).toBe(0);
  });

  it('reports a failed close, keeps that resource and retries only it', async () => {
    const { live } = setup();
    const closed = vi.fn();
    const failing = vi.fn().mockRejectedValueOnce(new Error('stop failed'));
    live.bind('a', { close: closed });
    live.bind('a', { close: failing });

    await expect(live.suspend('a', FROZEN())).rejects.toMatchObject({
      action: 'close',
      name: 'TenantLiveResourceError',
    });
    expect(live.size('a')).toBe(1);

    // The lifecycle retry closes what is left and succeeds.
    await expect(live.suspend('a', FROZEN())).resolves.toBeUndefined();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(live.size('a')).toBe(0);
  });

  it('counts a close that never settles as failed instead of hanging the lifecycle', async () => {
    const { live } = setup();
    live.bind('a', { close: () => new Promise(() => {}) });
    const suspended = live.suspend('a', FROZEN());
    const outcome = expect(suspended).rejects.toMatchObject({ action: 'close' });
    await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT);
    await outcome;
    expect(live.size('a')).toBe(1);
  });

  it('reports a failed reopen and retries it on the next resume', async () => {
    const { live } = setup();
    const reopen = vi.fn().mockRejectedValueOnce(new Error('start failed'));
    const close = vi.fn();
    live.bind('a', { close, reopen });
    await live.suspend('a', FROZEN());

    await expect(live.resume('a')).rejects.toMatchObject({ action: 'reopen' });
    await expect(live.resume('a')).resolves.toBeUndefined();
    expect(reopen).toHaveBeenCalledTimes(2);

    // Reopened: a later suspension closes it again.
    await live.suspend('a', FROZEN());
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('closes a resource bound while the tenant is suspended', async () => {
    const { live } = setup();
    live.bind('a', { close: vi.fn(), reopen: vi.fn() });
    await live.suspend('a', FROZEN());

    const late = vi.fn();
    live.bind('a', { close: late });
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_FROZEN' }));
  });

  it('applies concurrent suspend and resume in call order', async () => {
    const { live } = setup();
    let release!: () => void;
    const slowClose = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const reopen = vi.fn();
    live.bind('a', { close: slowClose, reopen });

    const suspended = live.suspend('a', FROZEN());
    const resumed = live.resume('a');
    await vi.advanceTimersByTimeAsync(0);
    // Resume waits for the close in progress instead of racing it.
    expect(reopen).not.toHaveBeenCalled();
    release();
    await suspended;
    await resumed;
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('closes the tenant on another process within one watch interval, without any local call', async () => {
    const { check, live, refused } = setup();
    const close = vi.fn();
    live.bind('a', { close });

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(check).toHaveBeenCalledWith('a');
    expect(close).not.toHaveBeenCalled();

    refused.set('a', new TenantGateError('TENANT_OFFLINE'));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_OFFLINE' }));
    // Nothing left to watch: the timer stops.
    check.mockClear();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(check).not.toHaveBeenCalled();
  });

  it('fails closed when the tenant cannot be checked', async () => {
    const { live, refused } = setup();
    const close = vi.fn();
    live.bind('a', { close });
    refused.set('a', new Error('platform down'));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_UNAVAILABLE' }));
  });

  it('fails closed when a check never answers, and keeps checking afterwards', async () => {
    const { check, live } = setup();
    const close = vi.fn();
    const reopen = vi.fn();
    live.bind('a', { close, reopen });
    check.mockImplementationOnce(() => new Promise(() => {}));

    await vi.advanceTimersByTimeAsync(INTERVAL + CHECK_TIMEOUT);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_UNAVAILABLE' }));

    // The hung check does not block the watcher: the next answer reopens.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('retries a failed close on the next watch tick', async () => {
    const { live, refused } = setup();
    const close = vi.fn().mockRejectedValueOnce(new Error('stop failed'));
    live.bind('a', { close });
    refused.set('a', FROZEN());

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(close).toHaveBeenCalledTimes(1);
    expect(live.size('a')).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(close).toHaveBeenCalledTimes(2);
    expect(live.size('a')).toBe(0);
  });

  it('ignores a watcher answer read before a newer local suspension', async () => {
    const { check, live } = setup();
    let answer!: () => void;
    const reopen = vi.fn();
    live.bind('a', { close: vi.fn(), reopen });
    // The watcher reads "admitted" just before the control plane suspends.
    check.mockImplementationOnce(() => new Promise<void>((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await live.suspend('a', FROZEN());
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('unbinds a finished resource', () => {
    const { live } = setup();
    const release = live.bind('a', { close: vi.fn() });
    release();
    expect(live.size('a')).toBe(0);
  });
});

describe('guardTenantStream', () => {
  const live = () => new TenantLiveResources(async () => {}, 60_000);

  it('passes the body through and unbinds when it ends', async () => {
    const registry = live();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const reader = guardTenantStream(registry, 'a', source).getReader();
    expect(registry.size('a')).toBe(1);
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    expect((await reader.read()).done).toBe(true);
    expect(registry.size('a')).toBe(0);
  });

  it('errors the response and cancels its source when the tenant is suspended', async () => {
    const registry = live();
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const reader = guardTenantStream(registry, 'a', source).getReader();
    const pending = reader.read();

    await registry.suspend('a', FROZEN());

    await expect(pending).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
    expect(cancelled).toHaveBeenCalled();
    expect(registry.size('a')).toBe(0);
  });

  it('keeps failing the suspension until the source is confirmed cancelled', async () => {
    const registry = live();
    const cancel = vi.fn(() => Promise.reject(new Error('upstream abort failed')));
    const reader = guardTenantStream(
      registry,
      'a',
      new ReadableStream<Uint8Array>({ cancel }),
    ).getReader();
    const pending = reader.read();

    await expect(registry.suspend('a', FROZEN())).rejects.toMatchObject({ action: 'close' });
    // The client side fails at once even though the upstream is still open.
    await expect(pending).rejects.toMatchObject({ code: 'TENANT_FROZEN' });
    expect(registry.size('a')).toBe(1);

    // The underlying cancel runs once; its failure sticks to every retry.
    await expect(registry.suspend('a', FROZEN())).rejects.toMatchObject({ action: 'close' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(registry.size('a')).toBe(1);
  });

  it('unregisters only once the source cancel has completed', async () => {
    const registry = live();
    let confirm!: () => void;
    const source = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>((resolve) => (confirm = resolve)),
    });
    guardTenantStream(registry, 'a', source).getReader();

    const suspended = registry.suspend('a', FROZEN());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.size('a')).toBe(1);
    confirm();
    await expect(suspended).resolves.toBeUndefined();
    expect(registry.size('a')).toBe(0);
  });

  it('keeps a client-cancelled stream registered when its source cancel fails', async () => {
    const registry = live();
    const cancel = vi.fn(() => Promise.reject(new Error('upstream abort failed')));
    const reader = guardTenantStream(
      registry,
      'a',
      new ReadableStream<Uint8Array>({ cancel }),
    ).getReader();

    await expect(reader.cancel('gone')).rejects.toThrow('upstream abort failed');
    expect(registry.size('a')).toBe(1);
    await expect(registry.suspend('a', FROZEN())).rejects.toMatchObject({ action: 'close' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the source and unbinds when the client disconnects', async () => {
    const registry = live();
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const reader = guardTenantStream(registry, 'a', source).getReader();
    await reader.cancel('gone');
    expect(cancelled).toHaveBeenCalledWith('gone');
    expect(registry.size('a')).toBe(0);
  });
});
