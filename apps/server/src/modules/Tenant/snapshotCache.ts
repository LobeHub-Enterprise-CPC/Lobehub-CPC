import { LRUCache } from 'lru-cache';

import { TenantRoutingUnavailableError } from './routingErrors';

const SNAPSHOT_TTL_MS = 5000;

interface Snapshot<T> {
  fetchedAt: number;
  /** Per-key invalidation sequence observed when the read started. */
  sequence: number;
  value: T | null;
}

/** Location snapshots only: admission, lifecycle and permissions remain the tenant gate's job.
 * Other replicas observe writes within five seconds; failures never extend an expired snapshot.
 */
export class SnapshotCache<T extends object> {
  private generation = 0;
  private sequence = 0;
  /**
   * Keys invalidated on their own. A marker only matters to reads that started before it, and every
   * such read expires within one TTL, so markers are dropped after that.
   */
  private readonly invalidated = new Map<string, { at: number; sequence: number }>();
  private readonly strictSnapshots = new LRUCache<string, Snapshot<T>>({ max: 1000 });
  private readonly strictReads = new Map<
    string,
    { running: Promise<T | null> | null; queued: Promise<T | null> | null }
  >();
  private readonly cache: LRUCache<string, Snapshot<T>>;
  private readonly pending = new Map<string, { aborted: boolean; startedAt: number }>();

  constructor(
    private readonly load: (key: string) => Promise<T | null>,
    private readonly now: () => number = () => performance.now(),
    snapshotStartedAt: (value: T) => number = () => Infinity,
    private readonly currentGeneration: () => number = () => this.generation,
  ) {
    this.cache = new LRUCache<string, Snapshot<T>>({
      max: 1000,
      ttl: SNAPSHOT_TTL_MS,
      ttlResolution: 0,
      fetchMethod: async (key, _stale, { signal }) => {
        const startedAt = this.now();
        const startedGeneration = this.currentGeneration();
        const startedSequence = this.sequence;
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
          if (
            this.currentGeneration() !== startedGeneration ||
            this.invalidatedSince(key, startedSequence)
          )
            throw new TenantRoutingUnavailableError('ROUTING_GENERATION_CHANGED');
          if (signal.aborted) throw new TenantRoutingUnavailableError('ROUTING_ABORTED');
          if (this.now() - fetchedAt >= SNAPSHOT_TTL_MS)
            throw new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED');
          return { value, fetchedAt, sequence: startedSequence };
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

  get invalidationMarkers() {
    return this.invalidated.size;
  }

  invalidate() {
    this.generation += 1;
    this.cache.clear();
    this.strictSnapshots.clear();
  }

  /** Drops one key and refuses its reads already in flight; other keys keep their snapshots. */
  invalidateKey(key: string) {
    const now = this.now();
    for (const [other, marker] of this.invalidated)
      if (now - marker.at >= SNAPSHOT_TTL_MS) this.invalidated.delete(other);
    this.sequence += 1;
    this.invalidated.set(key, { at: now, sequence: this.sequence });
    this.cache.delete(key);
    this.strictSnapshots.delete(key);
  }

  private invalidatedSince(key: string, sequence: number) {
    const marker = this.invalidated.get(key);
    if (!marker) return false;
    if (this.now() - marker.at >= SNAPSHOT_TTL_MS) {
      this.invalidated.delete(key);
      return false;
    }
    return marker.sequence > sequence;
  }

  /** Strict readers arriving during a read share one subsequent read. */
  getStrict(key: string): Promise<T | null> {
    let slot = this.strictReads.get(key);
    if (!slot) {
      slot = { running: null, queued: null };
      this.strictReads.set(key, slot);
    }
    if (slot.queued) return slot.queued;
    const start = () => {
      const startedAt = this.now();
      const generation = this.currentGeneration();
      const sequence = this.sequence;
      const promise = this.load(key).then((value) => {
        if (generation !== this.currentGeneration() || this.invalidatedSince(key, sequence))
          throw new TenantRoutingUnavailableError('ROUTING_GENERATION_CHANGED');
        if (this.now() - startedAt >= SNAPSHOT_TTL_MS)
          throw new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED');
        const current = this.strictSnapshots.get(key);
        if (!current || current.fetchedAt <= startedAt)
          this.strictSnapshots.set(key, { value, fetchedAt: startedAt, sequence });
        return value;
      });
      slot.running = promise;
      const clear = () => {
        if (slot.running === promise) slot.running = null;
        if (!slot.running && !slot.queued) this.strictReads.delete(key);
      };
      promise.then(clear, clear);
      return promise;
    };
    if (!slot.running) return start();
    const settled = () => undefined;
    slot.queued = slot.running.then(settled, settled).then(() => {
      slot.queued = null;
      return start();
    });
    return slot.queued;
  }

  async get(key: string): Promise<T | null> {
    if (this.generation !== this.currentGeneration()) {
      this.cache.clear();
      this.strictSnapshots.clear();
      this.generation = this.currentGeneration();
    }
    const strict = this.strictSnapshots.get(key);
    if (strict && this.now() - strict.fetchedAt < SNAPSHOT_TTL_MS) return strict.value;
    const pending = this.pending.get(key);
    if (pending && this.now() - pending.startedAt >= SNAPSHOT_TTL_MS) this.cache.delete(key);
    const cached = this.cache.peek(key);
    if (cached && this.now() - cached.fetchedAt >= SNAPSHOT_TTL_MS) this.cache.delete(key);
    const startedGeneration = this.currentGeneration();
    const startedSequence = this.sequence;
    const fetch = async () => {
      const loading = this.cache.fetch(key);
      const pending = this.pending.get(key);
      try {
        const snapshot = await loading;
        if (
          startedGeneration !== this.currentGeneration() ||
          this.invalidatedSince(key, startedSequence)
        )
          throw new TenantRoutingUnavailableError('ROUTING_GENERATION_CHANGED');
        if (!snapshot) throw new TenantRoutingUnavailableError('ROUTING_SNAPSHOT_MISSING');
        return snapshot;
      } catch (cause) {
        if (
          startedGeneration !== this.currentGeneration() ||
          this.invalidatedSince(key, startedSequence)
        )
          throw new TenantRoutingUnavailableError('ROUTING_GENERATION_CHANGED');
        if (pending?.aborted) throw new TenantRoutingUnavailableError('ROUTING_ABORTED');
        throw cause;
      }
    };
    let snapshot = await fetch();
    if (this.now() - snapshot.fetchedAt >= SNAPSHOT_TTL_MS) {
      this.cache.delete(key);
      // A cache hit can cross the TTL while its promise returns. Only that old hit
      // gets one fresh lookup; a lookup that consumed its own budget never retries.
      if (snapshot !== cached) throw new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED');
      snapshot = await fetch();
      if (this.now() - snapshot.fetchedAt >= SNAPSHOT_TTL_MS) {
        this.cache.delete(key);
        throw new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED');
      }
    }
    return snapshot.value;
  }
}
