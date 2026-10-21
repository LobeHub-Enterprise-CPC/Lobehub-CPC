import type { PlatformDatabase } from '@lobechat/database/platform';
import { tenantDestruction, tenantDirectory, tenantLifecycle } from '@lobechat/database/platform';
import { eq, getTableColumns } from 'drizzle-orm';

import { TenantGateError } from './errors';
import { SnapshotCache } from './snapshotCache';

// Request admission never needs the schema owner's credentials.
const {
  ownerSecret: _ownerSecret,
  ownerUsername: _ownerUsername,
  ...runtimeColumns
} = getTableColumns(tenantDirectory);

export interface TenantDirectoryEntry {
  /** The tenant UUID has a destruction terminal: admission refuses it from the barrier on. */
  destroyed?: boolean;
  directory: Omit<typeof tenantDirectory.$inferSelect, 'ownerSecret' | 'ownerUsername'>;
  lifecycle: typeof tenantLifecycle.$inferSelect | null;
}

const toEntry = ({
  destruction,
  ...entry
}: {
  destruction?: string | null;
  directory: TenantDirectoryEntry['directory'];
  lifecycle: TenantDirectoryEntry['lifecycle'];
}): TenantDirectoryEntry => ({ ...entry, destroyed: !!destruction });

/** PostgreSQL is authoritative; this process only holds bounded, short-lived routing snapshots. */
export class TenantDirectoryRepository {
  private readonly routes: SnapshotCache<TenantDirectoryEntry>;

  constructor(
    private readonly platform: () => PlatformDatabase,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.routes = new SnapshotCache((slug) => this.find(eq(tenantDirectory.slug, slug)), now);
  }

  async findBySlug(slug: string): Promise<TenantDirectoryEntry | null> {
    try {
      return await this.routes.get(slug);
    } catch (cause) {
      throw new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause });
    }
  }

  findById(tenantId: string): Promise<TenantDirectoryEntry | null> {
    return this.find(eq(tenantDirectory.tenantId, tenantId));
  }

  /** Writes are rare. Clearing also cancels reads whose tenant id is not known yet. */
  invalidate() {
    this.routes.invalidate();
  }

  async list(): Promise<TenantDirectoryEntry[]> {
    return (await this.query()).map(toEntry);
  }

  private query() {
    return this.platform()
      .select({
        destruction: tenantDestruction.tenantId,
        directory: runtimeColumns,
        lifecycle: tenantLifecycle,
      })
      .from(tenantDirectory)
      .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenantDirectory.tenantId))
      .leftJoin(tenantDestruction, eq(tenantDestruction.tenantId, tenantDirectory.tenantId));
  }

  private async find(where: ReturnType<typeof eq>): Promise<TenantDirectoryEntry | null> {
    const startedAt = this.now();
    try {
      const [entry] = await this.query().where(where).limit(1);
      // A slow read may predate a lifecycle change already enforced elsewhere.
      if (this.now() - startedAt >= 5000) throw new TenantGateError('TENANT_UNAVAILABLE');
      return entry ? toEntry(entry) : null;
    } catch (cause) {
      console.error('[TenantDirectory] lookup failed:', (cause as Error).name);
      throw new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause });
    }
  }
}
