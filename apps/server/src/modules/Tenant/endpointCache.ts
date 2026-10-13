import { LRUCache } from 'lru-cache';

import { TenantEndpointError } from '@/server/services/tenantControlPlane/endpointsContract';

import { TenantGateError } from './errors';

export const ENDPOINT_ROUTING_TTL_MS = 5000;
let generation = 0;

/** Call only after the endpoint transaction commits. All authority/id keys become obsolete. */
export const invalidateEndpointRouting = () => {
  generation += 1;
};

/** Location snapshots only: admission, lifecycle and permissions remain the tenant gate's job.
 * Other replicas observe writes within five seconds; failures never extend an expired snapshot.
 */
export class EndpointRoutingCache<T extends object> {
  private generation = generation;
  private readonly cache: LRUCache<string, { value: T | null; fetchedAt: number }>;
  private readonly pending = new Map<string, { startedAt: number }>();

  constructor(
    load: (key: string) => Promise<T | null>,
    private readonly now: () => number = () => performance.now(),
    snapshotStartedAt: (value: T) => number = () => Infinity,
  ) {
    this.cache = new LRUCache<string, { value: T | null; fetchedAt: number }>({
      max: 1000,
      ttl: ENDPOINT_ROUTING_TTL_MS,
      ttlResolution: 0,
      fetchMethod: async (key, _stale, { signal }) => {
        const startedAt = this.now();
        const startedGeneration = generation;
        const pending = { startedAt };
        this.pending.set(key, pending);
        const forget = () => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        };
        // LRU eviction and invalidation abort fetches, bounding pending metadata too.
        signal.addEventListener('abort', forget, { once: true });
        try {
          const value = await load(key);
          const fetchedAt = value ? Math.min(startedAt, snapshotStartedAt(value)) : startedAt;
          // Never refill after commit invalidation, pending expiry or LRU eviction.
          if (
            signal.aborted ||
            generation !== startedGeneration ||
            this.now() - fetchedAt >= ENDPOINT_ROUTING_TTL_MS
          )
            throw new TenantGateError('TENANT_UNAVAILABLE');
          return { value, fetchedAt };
        } finally {
          forget();
          signal.removeEventListener('abort', forget);
        }
      },
    });
  }

  get size() {
    return this.cache.size;
  }

  async get(key: string): Promise<T | null> {
    try {
      if (this.generation !== generation) {
        this.cache.clear();
        this.generation = generation;
      }
      const pending = this.pending.get(key);
      if (pending && this.now() - pending.startedAt >= ENDPOINT_ROUTING_TTL_MS)
        this.cache.delete(key);
      const cached = this.cache.peek(key);
      if (cached && this.now() - cached.fetchedAt >= ENDPOINT_ROUTING_TTL_MS)
        this.cache.delete(key);
      const startedGeneration = generation;
      const snapshot = await this.cache.fetch(key);
      if (!snapshot || startedGeneration !== generation)
        throw new TenantGateError('TENANT_UNAVAILABLE');
      if (this.now() - snapshot.fetchedAt >= ENDPOINT_ROUTING_TTL_MS) {
        this.cache.delete(key);
        // The lookup itself already consumed the freshness budget. Refuse this request;
        // a later request may try again, without recursively retrying a slow database.
        throw new TenantGateError('TENANT_UNAVAILABLE');
      }
      return snapshot.value;
    } catch (cause) {
      if (cause instanceof TenantEndpointError || cause instanceof TenantGateError) throw cause;
      throw new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause });
    }
  }
}
