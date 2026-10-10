import { randomUUID } from 'node:crypto';

/** Persistence is acknowledged before work starts, and removed only after real completion. */
export interface TenantClaimStore {
  acquire: (tenantId: string, token: string) => Promise<void>;
  release: (tenantId: string, token: string) => Promise<void>;
}

interface Claim {
  acquiring?: Promise<void>;
  held: boolean;
  pins: number;
  releasing?: Promise<void>;
  token: string;
  tokens: number;
  uncertain: boolean;
}

/** Per-process admission pins close the await/acquire/register/release race. */
export class TenantClaims {
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly entries = new Map<string, Claim>();

  constructor(private readonly store: TenantClaimStore) {}

  isHeld(tenantId: string) {
    const entry = this.entries.get(tenantId);
    return Boolean(entry?.held && !entry.uncertain && entry.tokens > 0);
  }

  async enter(tenantId: string): Promise<() => Promise<void>> {
    let entry = this.entries.get(tenantId);
    if (!entry) {
      entry = { held: false, pins: 0, token: randomUUID(), tokens: 0, uncertain: false };
      this.entries.set(tenantId, entry);
    }
    entry.pins += 1; // Must precede the first await.
    try {
      if (entry.releasing) await entry.releasing;
      if (entry.uncertain) await this.release(tenantId, entry);
      {
        if (!entry.acquiring) {
          if (!entry.held) entry.token = randomUUID();
          entry.acquiring = this.store.acquire(tenantId, entry.token).then(() => {
            entry!.held = true;
          });
        }
        const acquiring = entry.acquiring;
        try {
          await acquiring;
        } finally {
          if (entry.acquiring === acquiring) entry.acquiring = undefined;
        }
      }
      entry.tokens += 1;
      return this.completion(tenantId, entry);
    } finally {
      entry.pins -= 1;
      if (entry.held && entry.pins === 0 && entry.tokens === 0) await this.release(tenantId, entry);
    }
  }

  /** Synchronous children are legal only while an admitted parent is still live. */
  bind(tenantId: string): () => Promise<void> {
    const entry = this.entries.get(tenantId);
    if (!entry?.held || entry.uncertain || entry.tokens === 0)
      throw new Error('TENANT_WORK_NOT_ADMITTED');
    entry.tokens += 1;
    return this.completion(tenantId, entry);
  }

  private completion(tenantId: string, entry: Claim) {
    let completed = false;
    return async () => {
      if (completed) return;
      completed = true;
      entry.tokens -= 1;
      if (entry.tokens === 0 && entry.pins === 0) await this.release(tenantId, entry);
    };
  }

  private async release(tenantId: string, entry: Claim): Promise<void> {
    if (entry.releasing) return entry.releasing;
    entry.held = false;
    entry.uncertain = true;
    const releasing = this.store.release(tenantId, entry.token).then(() => {
      entry.uncertain = false;
    });
    entry.releasing = releasing;
    try {
      await releasing;
    } catch (error) {
      if (!this.retries.has(tenantId)) {
        const timer = setTimeout(() => {
          this.retries.delete(tenantId);
          if (entry.tokens === 0 && entry.pins === 0 && entry.uncertain)
            void this.release(tenantId, entry).catch(() => undefined);
        }, 2000);
        timer.unref?.();
        this.retries.set(tenantId, timer);
      }
      throw error;
    } finally {
      if (entry.releasing === releasing) entry.releasing = undefined;
    }
  }
}
