import type { PlatformDatabase } from '@lobechat/database/platform';
import { tenantDirectory, tenantLifecycle } from '@lobechat/database/platform';
import { eq, getTableColumns } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';

import { TenantGateError } from './errors';

// Request admission never needs the schema owner's credentials.
const {
  ownerSecret: _ownerSecret,
  ownerUsername: _ownerUsername,
  ...runtimeColumns
} = getTableColumns(tenantDirectory);

export interface TenantDirectoryEntry {
  directory: Omit<typeof tenantDirectory.$inferSelect, 'ownerSecret' | 'ownerUsername'>;
  lifecycle: typeof tenantLifecycle.$inferSelect | null;
}

/** PostgreSQL is authoritative; this process only holds bounded, short-lived routing snapshots. */
export class TenantDirectoryRepository {
  private readonly routes = new LRUCache<
    string,
    { entry: TenantDirectoryEntry; fetchedAt: number }
  >({
    fetchMethod: async (slug) => {
      const fetchedAt = this.now();
      const entry = await this.find(eq(tenantDirectory.slug, slug));
      return entry ? { entry, fetchedAt } : undefined;
    },
    max: 1000,
    ttl: 5000,
    ttlResolution: 0,
  });

  constructor(
    private readonly platform: () => PlatformDatabase,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async findBySlug(slug: string): Promise<TenantDirectoryEntry | null> {
    try {
      const snapshot = await this.routes.fetch(slug);
      if (!snapshot) return null;
      if (this.now() - snapshot.fetchedAt >= 5000) {
        this.routes.delete(slug);
        return await this.findBySlug(slug);
      }
      return snapshot.entry;
    } catch (cause) {
      // Invalidation aborts pending fetches as well: never admit with a stale snapshot.
      throw new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause });
    }
  }

  findById(tenantId: string): Promise<TenantDirectoryEntry | null> {
    return this.find(eq(tenantDirectory.tenantId, tenantId));
  }

  /** Writes are rare. Clearing also cancels reads whose tenant id is not known yet. */
  invalidate() {
    this.routes.clear();
  }

  async list(): Promise<TenantDirectoryEntry[]> {
    return this.query();
  }

  private query() {
    return this.platform()
      .select({ directory: runtimeColumns, lifecycle: tenantLifecycle })
      .from(tenantDirectory)
      .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenantDirectory.tenantId));
  }

  private async find(where: ReturnType<typeof eq>): Promise<TenantDirectoryEntry | null> {
    const startedAt = this.now();
    try {
      const [entry] = await this.query().where(where).limit(1);
      // A slow read may predate a lifecycle change already enforced elsewhere.
      if (this.now() - startedAt >= 5000) throw new TenantGateError('TENANT_UNAVAILABLE');
      return entry ?? null;
    } catch (cause) {
      console.error('[TenantDirectory] lookup failed:', (cause as Error).name);
      throw new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause });
    }
  }
}
