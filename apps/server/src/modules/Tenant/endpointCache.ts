import { TenantEndpointError } from './endpointContract';
import { TenantGateError } from './errors';
import { TenantRoutingUnavailableError } from './routingErrors';
import { SnapshotCache } from './snapshotCache';

export const ENDPOINT_ROUTING_TTL_MS = 5000;
let generation = 0;
export const invalidateEndpointRouting = () => {
  generation += 1;
};

export class EndpointRoutingCache<T extends object> {
  private readonly cache: SnapshotCache<T>;
  constructor(
    load: (key: string) => Promise<T | null>,
    now?: () => number,
    snapshotStartedAt?: (value: T) => number,
  ) {
    this.cache = new SnapshotCache(load, now, snapshotStartedAt, () => generation);
  }
  get size() {
    return this.cache.size;
  }
  async get(key: string): Promise<T | null> {
    try {
      return await this.cache.get(key);
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
