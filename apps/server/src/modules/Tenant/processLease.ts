import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';

import { TenantGateError } from './errors';

export const TENANT_PROCESS_LEASE_MS = 15_000;
export const TENANT_PROCESS_HEARTBEAT_MS = 3000;

export interface TenantLeaseStore {
  remove: (processId: string) => Promise<void>;
  renew: (processId: string) => Promise<void>;
}

/** Requests use the local deadline, never a per-request platform write. */
export class TenantProcessLease {
  readonly processId = randomUUID();
  private validUntil = 0;
  private renewal?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private started = false;
  private readonly onTerminate = () => {
    if (this.stopping) return;
    // A stuck database must not prevent SIGTERM forever. Expiry is authoritative.
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      this.terminate();
    };
    const timeout = setTimeout(terminate, 500);
    void this.stop().finally(() => {
      clearTimeout(timeout);
      terminate();
    });
  };

  constructor(
    private readonly store: TenantLeaseStore,
    private readonly now = () => performance.now(),
    private readonly signals: Pick<EventEmitter, 'on' | 'removeListener'> = process,
    private readonly terminate = () => process.kill(process.pid, 'SIGTERM'),
  ) {}

  assertValid() {
    if (!this.stopping && this.validUntil > 0 && this.now() >= this.validUntil) this.onTerminate();
    if (this.stopping || this.now() >= this.validUntil)
      throw new TenantGateError('TENANT_UNAVAILABLE');
  }

  async ensure() {
    if (this.stopping) throw new TenantGateError('TENANT_UNAVAILABLE');
    if (!this.started) {
      this.started = true;
      this.signals.on('SIGTERM', this.onTerminate);
      this.timer = setInterval(() => {
        void this.heartbeat().catch((error) =>
          console.error('[TenantLease] renewal failed', error),
        );
      }, TENANT_PROCESS_HEARTBEAT_MS);
      this.timer.unref?.();
      await this.heartbeat();
    } else if (this.renewal && this.validUntil === 0) {
      await this.renewal;
    }
    this.assertValid();
  }

  heartbeat(): Promise<void> {
    if (this.stopping) return Promise.reject(new TenantGateError('TENANT_UNAVAILABLE'));
    if (this.validUntil > 0 && this.now() >= this.validUntil) {
      this.onTerminate();
      return Promise.reject(new TenantGateError('TENANT_UNAVAILABLE'));
    }
    if (this.renewal) return this.renewal;
    const startedAt = this.now();
    const renewal = this.store.renew(this.processId).then(() => {
      if (this.stopping) return;
      // Count database latency against the TTL; leave a margin for clock/transport skew.
      this.validUntil = startedAt + TENANT_PROCESS_LEASE_MS - 1000;
      this.assertValid();
      if (this.expiryTimer) clearTimeout(this.expiryTimer);
      // Self-fence before the database lease expires, including a hung renewal.
      this.expiryTimer = setTimeout(this.onTerminate, this.validUntil - this.now());
      this.expiryTimer.unref?.();
    });
    this.renewal = renewal;
    const clear = () => {
      if (this.renewal === renewal) this.renewal = undefined;
    };
    void renewal.then(clear, clear);
    return renewal;
  }

  async stop() {
    this.stopping = true;
    this.validUntil = 0;
    if (this.timer) clearInterval(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.signals.removeListener('SIGTERM', this.onTerminate);
    // Serialize removal after any outstanding upsert so it cannot resurrect the lease.
    await this.renewal?.catch((error) =>
      console.error('[TenantLease] final renewal failed', error),
    );
    await this.store.remove(this.processId).catch((error) => {
      console.error('[TenantLease] deregistration failed; awaiting expiry', error);
    });
  }
}
