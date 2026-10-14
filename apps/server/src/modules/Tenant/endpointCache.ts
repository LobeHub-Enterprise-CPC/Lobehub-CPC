import { LRUCache } from 'lru-cache';

import { TenantEndpointError } from '@/server/services/tenantControlPlane/endpointsContract';

import { TenantGateError } from './errors';
import { TenantRoutingUnavailableError } from './routingErrors';

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
  private readonly pending = new Map<string, { aborted: boolean; startedAt: number }>();

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
        const pending = { aborted: false, startedAt };
        this.pending.set(key, pending);
        const forget = () => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        };
        // LRU eviction and invalidation abort fetches, bounding pending metadata too.
        const abort = () => {
          pending.aborted = true;
          forget();
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const value = await load(key);
          const fetchedAt = value ? Math.min(startedAt, snapshotStartedAt(value)) : startedAt;
          // Never refill after commit invalidation, pending expiry or LRU eviction.
          if (generation !== startedGeneration)
            throw new TenantRoutingUnavailableError('ROUTING_GENERATION_CHANGED');
          if (signal.aborted) throw new TenantRoutingUnavailableError('ROUTING_ABORTED');
          if (this.now() - fetchedAt >= ENDPOINT_ROUTING_TTL_MS)
            throw new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED');
          return { value, fetchedAt };
        } finally {
          forget();
          signal.removeEventListener('abort', abort);
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
      const fetch = async () => {
        const loading = this.cache.fetch(key);
        const pending = this.pending.get(key);
        try {
          const snapshot = await loading;
          if (startedGeneration !== generation)
            throw new TenantRoutingUnavailableError('ROUTING_GENERATION_CHANGED');
          if (!snapshot) throw new TenantRoutingUnavailableError('ROUTING_SNAPSHOT_MISSING');
          return snapshot;
        } catch (cause) {
          if (startedGeneration !== generation)
            throw new TenantRoutingUnavailableError('ROUTING_GENERATION_CHANGED');
          if (pending?.aborted) throw new TenantRoutingUnavailableError('ROUTING_ABORTED');
          throw cause;
        }
      };
      let snapshot = await fetch();
      if (this.now() - snapshot.fetchedAt >= ENDPOINT_ROUTING_TTL_MS) {
        this.cache.delete(key);
        // A cache hit can cross the TTL while its promise returns. Only that old hit
        // gets one fresh lookup; a lookup that consumed its own budget never retries.
        if (snapshot !== cached) throw new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED');
        snapshot = await fetch();
        if (this.now() - snapshot.fetchedAt >= ENDPOINT_ROUTING_TTL_MS) {
          this.cache.delete(key);
          throw new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED');
        }
      }
      return snapshot.value;
    } catch (cause) {
      if (
        cause instanceof TenantEndpointError ||
        cause instanceof TenantGateError ||
        cause instanceof TenantRoutingUnavailableError
      )
        throw cause;
      throw new TenantRoutingUnavailableError('ROUTING_LOOKUP_FAILED', { cause });
    }
  }
}
