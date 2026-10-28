import type { PlatformDatabase } from '@lobechat/database/platform';
import { getPlatformDB } from '@lobechat/database/platform';
import {
  SUPPORTED_TENANT_SCHEMA_VERSIONS,
  TenantDatabaseError,
  TenantDatabaseSession,
  tenantDbNames,
  tenantDrainLockKey,
  TenantPoolManager,
  type TenantScope,
} from '@lobechat/database/tenant';
import debug from 'debug';
import { sql } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';

import { observeBorrowedClientErrors } from '@/database/tenant/session';

import type { TenantClaims } from './claims';
import { connectionFromDirectory } from './directoryConnection';
import type { TenantDirectoryEntry } from './directoryRepository';
import { TenantDirectoryRepository } from './directoryRepository';
import { loadTenantPublicEndpoint } from './endpoints';
import { TenantGateError } from './errors';
import { effectiveTenantState } from './lifecycleState';
import { tenantClaims } from './postgresClaims';
import { SnapshotCache } from './snapshotCache';
import { verifyRuntimeTenantDatabase } from './verifyDatabase';

const log = debug('lobe-server:tenant');

/**
 * Directory + lifecycle facts are cached per process for at most this long
 * (FR-ID-07 ≤ 5 s). It is also the propagation bound of a lifecycle change:
 * once this long has passed after Console's event was received, every process
 * refuses new admissions and new transactions of the tenant.
 */
export const TENANT_ADMISSION_TTL_MS = 5000;

type DirectoryRow = TenantDirectoryEntry['directory'];
type RouteEntry = TenantDirectoryEntry;

/**
 * Tenant resolution and admission (spec FR-RT-04, FR-ID-07, FR-DI-02..05).
 *
 * Input is only a slug (today from the `/orgs/{slug}` path, later possibly from
 * a Host mapping, spec A17) or a trusted tenant id (jobs). Output is a
 * {@link TenantScope}: the tenant id, its slug, and a database session bound
 * to the tenant's schema through its runtime role. Every failure is a
 * {@link TenantGateError}; nothing falls back to another connection or tenant.
 */
export class TenantRuntime {
  private readonly directory: TenantDirectoryRepository;
  private readonly byId: SnapshotCache<RouteEntry>;
  private readonly sessions = new LRUCache<string, { key: string; session: TenantDatabaseSession }>(
    { max: 1000 },
  );
  private readonly verified = new LRUCache<string, Promise<void>>({ max: 1000 });

  constructor(
    private readonly platform: () => PlatformDatabase,
    private readonly pools: TenantPoolManager,
    private readonly now: () => Date = () => new Date(),
    private readonly claims?: TenantClaims,
    private readonly verifyDatabase = verifyRuntimeTenantDatabase,
  ) {
    this.directory = new TenantDirectoryRepository(platform, () => this.now().getTime());
    this.byId = new SnapshotCache(
      (id) => this.directory.findById(id),
      () => this.now().getTime(),
    );
  }

  /** Drops cached routing facts and sessions for a tenant (lifecycle stage 1, rotation). */
  invalidate(tenantId: string) {
    this.directory.invalidate();
    this.byId.invalidateKey(tenantId);
    this.sessions.delete(tenantId);
    for (const key of this.verified.keys())
      if (key.startsWith(`${tenantId}|`)) this.verified.delete(key);
  }

  /**
   * Destruction unregister and heartbeat: forgets the tenant's routing facts and sessions and retires
   * its connection pools in this process. Returns whether this process held a live connection route.
   */
  retire(tenantId: string): boolean {
    const held = this.sessions.has(tenantId);
    this.invalidate(tenantId);
    this.pools.invalidateTenant(tenantId);
    return held;
  }

  async enterSlug(slug: string) {
    const entry = await this.directory.findBySlug(slug);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    return this.enter(entry);
  }

  /** Jobs enter by trusted tenant id on the same ≤ TTL admission facts as requests. */
  async enterTenantId(tenantId: string) {
    const entry = await this.admissionEntry(tenantId, TENANT_ADMISSION_TTL_MS);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    return this.enter(entry);
  }

  private async enter(entry: RouteEntry) {
    this.assertAvailable(entry);
    if (!this.claims) throw new TenantGateError('TENANT_UNAVAILABLE');
    const release = await this.claims.enter(entry.directory.tenantId);
    try {
      // Pin first, then read admission: a heartbeat cannot publish a drained generation
      // while an older directory lookup is still waiting to register this request.
      const admitted = await this.admissionEntry(entry.directory.tenantId, TENANT_ADMISSION_TTL_MS);
      if (!admitted) throw new TenantGateError('TENANT_NOT_FOUND');
      this.assertAvailable(admitted);
      return {
        release,
        scope: {
          ...(await this.openScope(admitted.directory)),
          acceptedVersion: admitted.lifecycle!.acceptedVersion,
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  /**
   * Re-checks a tenant whose work was admitted earlier (FR-DI-07): long
   * requests, streams and queued steps keep their scope, so every new tenant
   * transaction and every realtime watcher asks again. Facts are at most
   * `maxAgeMs` old, counted from when their read started; concurrent checks
   * share a platform read only while it is that fresh. `maxAgeMs <= 0` asks
   * for a read that starts after this call (see {@link readStrict}).
   */
  async assertAdmitted(tenantId: string, maxAgeMs = TENANT_ADMISSION_TTL_MS): Promise<void> {
    const entry = await this.admissionEntry(tenantId, maxAgeMs);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    this.assertAvailable(entry);
  }

  /** Platform-only fresh authority, including denied lifecycle states; never opens the business DB. */
  async gatewayAdmission(tenantId: string) {
    const checkedAt = this.now().getTime();
    const entry = await this.admissionEntry(tenantId, 0);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    if (entry.destroyed) throw new TenantGateError('TENANT_DESTROYED');
    const lifecycle = entry.lifecycle;
    if (entry.directory.status !== 'active' || !lifecycle?.acceptedVersion)
      throw new TenantGateError('TENANT_NOT_READY');
    const effective = effectiveTenantState(
      {
        desiredState: lifecycle.desiredState,
        expiresAt: lifecycle.expiresAt?.toISOString() ?? null,
        freezeReasons: lifecycle.freezeReasons,
      },
      this.now(),
    );
    const effectiveState =
      effective.reasons.length === 1 && effective.reasons[0] === 'expired'
        ? 'expired'
        : effective.state;
    return {
      tenantId,
      acceptedVersion: lifecycle.acceptedVersion,
      effectiveState,
      checkedAt,
      leaseExpiresAt: checkedAt + 30_000,
    };
  }

  /** Admission facts at most `maxAgeMs` old (see {@link assertAdmitted}). */
  private async admissionEntry(tenantId: string, maxAgeMs: number): Promise<RouteEntry | null> {
    try {
      return await (maxAgeMs <= 0 ? this.byId.getStrict(tenantId) : this.byId.get(tenantId));
    } catch (cause) {
      throw new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause });
    }
  }

  /** Tenants a cron should visit (FR-AS-02): registered and currently admitted. */
  async listAvailableTenantIds(): Promise<string[]> {
    const rows = await this.directory.list();
    return rows
      .filter((entry) => {
        try {
          this.assertAvailable(entry);
          return true;
        } catch {
          return false;
        }
      })
      .map(({ directory }) => directory.tenantId);
  }

  /**
   * Waits for the tenant's in-flight business transactions (FR-DI-07): takes
   * the drain lock exclusively, which every business transaction holds shared.
   */
  async drainTransactions(tenantId: string, timeoutMs = 30_000) {
    const entry = await this.directory.findById(tenantId);
    if (!entry) return;
    // Not admission-checked: the drain runs exactly when the tenant is refused.
    const session = new TenantDatabaseSession({
      acquire: this.acquireFor(entry.directory),
      schemaName: entry.directory.schemaName,
      tenantId,
    });
    const key = tenantDrainLockKey(tenantId);
    await session.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    });
  }

  private assertAvailable(entry: RouteEntry) {
    const { directory, lifecycle } = entry;
    // From the destruction barrier on, whatever the lifecycle says: a destroyed tenant is never admitted.
    if (entry.destroyed) throw new TenantGateError('TENANT_DESTROYED');
    if (directory.status !== 'active')
      throw new TenantGateError('TENANT_NOT_READY', undefined, { source: 'admission' });
    // A tenant Console has never activated is not ready rather than offline.
    if (!lifecycle || lifecycle.acceptedVersion === 0)
      throw new TenantGateError('TENANT_NOT_READY', undefined, { source: 'admission' });
    const { state, reasons } = effectiveTenantState(
      {
        desiredState: lifecycle.desiredState,
        expiresAt: lifecycle.expiresAt?.toISOString() ?? null,
        freezeReasons: lifecycle.freezeReasons,
      },
      this.now(),
    );
    if (state === 'offline') throw new TenantGateError('TENANT_OFFLINE');
    if (state === 'frozen') {
      if (reasons.length === 1 && reasons[0] === 'expired')
        throw new TenantGateError('TENANT_EXPIRED');
      throw new TenantGateError('TENANT_FROZEN', { freezeReasons: reasons });
    }
  }

  private sessionFor(directory: DirectoryRow): TenantDatabaseSession {
    const names = tenantDbNames(directory.tenantId);
    if (
      directory.schemaName !== names.schemaName ||
      directory.runtimeUsername !== names.runtimeUsername
    )
      throw new TenantGateError('TENANT_NOT_READY', undefined, {
        cause: new TenantDatabaseError('TENANT_NOT_READY', 'schema-name-invalid'),
      });
    if (!SUPPORTED_TENANT_SCHEMA_VERSIONS.has(directory.schemaVersion))
      throw new TenantGateError('TENANT_NOT_READY', undefined, {
        cause: new TenantDatabaseError('TENANT_NOT_READY', 'schema-version-incompatible'),
      });

    const key = `${directory.connectionVersion}|${directory.credentialBundleVersion}|${directory.schemaVersion}`;
    const cached = this.sessions.get(directory.tenantId);
    if (cached?.key === key) return cached.session;

    const { tenantId } = directory;
    const session = new TenantDatabaseSession({
      acquire: this.acquireFor(directory),
      // Live request pins prevent a stop receipt until work settles. Console
      // events and heartbeat generations invalidate these bounded snapshots.
      admit: async () => {
        await this.claims?.assertValid();
        if (this.claims && !this.claims.isHeld(tenantId))
          throw new TenantGateError('TENANT_UNAVAILABLE');
        await this.assertAdmitted(tenantId, TENANT_ADMISSION_TTL_MS);
      },
      schemaName: directory.schemaName,
      tenantId,
    });
    this.sessions.set(tenantId, { key, session });
    return session;
  }

  /** Pool lease factory over the tenant's runtime credential. */
  private acquireFor(directory: DirectoryRow) {
    let connection: ReturnType<typeof connectionFromDirectory>;
    try {
      connection = connectionFromDirectory(directory);
    } catch (cause) {
      throw new TenantGateError('TENANT_NOT_READY', undefined, {
        cause: new TenantDatabaseError('TENANT_NOT_READY', 'decrypt-failed', { cause }),
      });
    }

    return () =>
      this.pools.acquire({
        connection,
        connectionVersion: directory.connectionVersion,
        purpose: 'request',
        schemaName: directory.schemaName,
        tenantId: directory.tenantId,
      });
  }

  /** Verify real connection identity, permissions, schema and release history before use. */
  private async openScope(directory: DirectoryRow): Promise<Omit<TenantScope, 'acceptedVersion'>> {
    const session = this.sessionFor(directory);
    const verifiedKey = `${directory.tenantId}|${directory.connectionVersion}|${directory.credentialBundleVersion}|${directory.schemaVersion}`;
    let verification = this.verified.get(verifiedKey);
    if (!verification) {
      verification = (async () => {
        const startedAt = this.now().getTime();
        const lease = this.acquireFor(directory)();
        try {
          const client = await lease.pool.connect();
          const observation = observeBorrowedClientErrors(client);
          try {
            await this.verifyDatabase(client, {
              schemaName: directory.schemaName,
              tenantId: directory.tenantId,
            });
          } finally {
            observation.release();
          }
        } catch (cause) {
          log('tenant database verification failed for %s', directory.tenantId);
          throw new TenantGateError('TENANT_NOT_READY', undefined, { cause });
        } finally {
          lease.release();
        }
        // A first verification must not let its original admission outlive the
        // lifecycle propagation bound. Successful evidence itself is versioned.
        if (this.now().getTime() - startedAt >= TENANT_ADMISSION_TTL_MS)
          throw new TenantGateError('TENANT_UNAVAILABLE');
      })();
      this.verified.set(verifiedKey, verification);
    }
    try {
      await verification;
    } catch (error) {
      if (this.verified.get(verifiedKey) === verification) this.verified.delete(verifiedKey);
      throw error;
    }
    const endpoint = await loadTenantPublicEndpoint(directory.tenantId, this.platform()).catch(
      (cause) => {
        if (cause instanceof TenantGateError) throw cause;
        throw new TenantGateError('TENANT_NOT_READY', undefined, { cause });
      },
    );
    return { endpoint, session, slug: directory.slug, tenantId: directory.tenantId };
  }
}

let runtime: TenantRuntime | null = null;

/** The process-wide tenant runtime over the platform database. */
export const getTenantRuntime = (): TenantRuntime => {
  runtime ??= new TenantRuntime(
    getPlatformDB,
    new TenantPoolManager(),
    () => new Date(),
    tenantClaims,
  );
  return runtime;
};
