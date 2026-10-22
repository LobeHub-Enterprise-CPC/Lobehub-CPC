// @vitest-environment node
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { TenantProcessLease } from './processLease';

const setup = () => {
  let now = 0;
  const store = { renew: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const signals = new EventEmitter();
  const terminate = vi.fn();
  const lease = new TenantProcessLease(store, () => now, signals, terminate);
  return { lease, store, signals, terminate, advance: (ms: number) => (now += ms) };
};

describe('process heartbeat lease', () => {
  it('registers once for repeated requests and refuses admission after its local lease expires', async () => {
    const { lease, store, advance } = setup();
    await lease.ensure();
    for (let n = 0; n < 100; n++) await lease.ensure();
    expect(store.renew).toHaveBeenCalledTimes(1);
    advance(15_000);
    await expect(lease.ensure()).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    await lease.stop();
  });

  it('does not extend its authority when renewal fails or arrives after TTL', async () => {
    const { lease, store, advance } = setup();
    await lease.ensure();
    store.renew.mockImplementationOnce(async () => {
      advance(15_000);
    });
    await expect(lease.heartbeat()).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    await expect(lease.ensure()).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
    await lease.stop();
  });

  it('self-terminates before database expiry even if a renewal is hung, and never revives that lease', async () => {
    vi.useFakeTimers({ now: 0 });
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const store = { renew: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    const terminate = vi.fn();
    const lease = new TenantProcessLease(store, () => Date.now(), new EventEmitter(), terminate);
    try {
      await lease.ensure();
      store.renew.mockImplementationOnce(() => pending);
      const renewal = lease.heartbeat();
      await vi.advanceTimersByTimeAsync(14_500);
      expect(terminate).toHaveBeenCalledOnce();
      await expect(lease.ensure()).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
      resolve();
      await renewal;
      await lease.stop();
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      resolve();
      await lease.stop();
      vi.useRealTimers();
    }
  });

  it('SIGTERM deregisters, stops renewing and preserves termination', async () => {
    const { lease, store, signals, terminate } = setup();
    await lease.ensure();
    signals.emit('SIGTERM');
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    expect(store.remove).toHaveBeenCalledWith(lease.processId);
    await expect(lease.ensure()).rejects.toMatchObject({ code: 'TENANT_UNAVAILABLE' });
  });
});
