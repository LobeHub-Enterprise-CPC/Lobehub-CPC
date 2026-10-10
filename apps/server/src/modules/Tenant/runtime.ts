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

import { openDirectoryData } from '@/server/crypto/tenantKeys';
import { verifyRuntimeTenantDatabase } from '@/server/services/tenantControlPlane/postgresExecutor';
import { directorySecretAad } from '@/server/services/tenantControlPlane/postgresRepository';
import { effectiveTenantState } from '@/server/services/tenantControlPlane/service';

import type { TenantClaims } from './claims';
import type { TenantDirectoryEntry } from './directoryRepository';
import { TenantDirectoryRepository } from './directoryRepository';
import { TenantGateError } from './errors';
import { tenantClaims } from './postgresClaims';

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
 * Input is only a slug (today from the `/t/{slug}` path, later possibly from
 * a Host mapping, spec A17) or a trusted tenant id (jobs). Output is a
 * {@link TenantScope}: the tenant id, its slug, and a database session bound
 * to the tenant's schema through its runtime role. Every failure is a
 * {@link TenantGateError}; nothing falls back to another connection or tenant.
 */
export class TenantRuntime {
  private readonly directory: TenantDirectoryRepository;
  /** Admission facts for re-checks of already admitted work, by tenant id. */
  private readonly byId = new Map<string, { entry: RouteEntry | null; fetchedAt: number }>();
  private readonly loadingById = new Map<
    string,
    { promise: Promise<RouteEntry | null>; startedAt: number }
  >();
  private readonly sessions = new Map<string, { key: string; session: TenantDatabaseSession }>();
  /** Database verification expires with the same bound as admission facts. */
  private readonly verified = new Map<string, number>();

  constructor(
    platform: () => PlatformDatabase,
    private readonly pools: TenantPoolManager,
    private readonly now: () => Date = () => new Date(),
    private readonly claims?: TenantClaims,
    private readonly verifyDatabase = verifyRuntimeTenantDatabase,
  ) {
    this.directory = new TenantDirectoryRepository(platform, () => this.now().getTime());
  }

  /** Drops cached routing facts and sessions for a tenant (lifecycle stage 1, rotation). */
  invalidate(tenantId: string) {
    this.directory.invalidate();
    this.byId.delete(tenantId);
    this.sessions.delete(tenantId);
    for (const key of this.verified.keys())
      if (key.startsWith(`${tenantId}|`)) this.verified.delete(key);
  }

  async enterSlug(slug: string) {
    const entry = await this.directory.findBySlug(slug);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    return this.enter(entry);
  }

  async enterTenantId(tenantId: string) {
    const entry = await this.directory.findById(tenantId);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    return this.enter(entry);
  }

  private async enter(entry: RouteEntry) {
    this.assertAvailable(entry);
    if (!this.claims) throw new TenantGateError('TENANT_UNAVAILABLE');
    const release = await this.claims.enter(entry.directory.tenantId);
    try {
      return { release, scope: await this.openScope(entry.directory) };
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
   * share a platform read only while it is that fresh.
   */
  async assertAdmitted(tenantId: string, maxAgeMs = TENANT_ADMISSION_TTL_MS): Promise<void> {
    const cached = this.byId.get(tenantId);
    let entry: RouteEntry | null;
    if (cached && this.isFresh(cached.fetchedAt, maxAgeMs)) entry = cached.entry;
    else {
      let loading = this.loadingById.get(tenantId);
      if (!loading || !this.isFresh(loading.startedAt, maxAgeMs)) {
        const startedAt = this.now().getTime();
        const promise = this.directory.findById(tenantId).then((loaded) => {
          this.byId.set(tenantId, { entry: loaded, fetchedAt: startedAt });
          return loaded;
        });
        const current = { promise, startedAt };
        void promise
          .catch(() => undefined)
          .finally(() => {
            if (this.loadingById.get(tenantId) === current) this.loadingById.delete(tenantId);
          });
        this.loadingById.set(tenantId, current);
        loading = current;
      }
      entry = await loading.promise;
    }
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    this.assertAvailable(entry);
  }

  /** Tenants a cron should visit (FR-AS-02): registered and currently admitted. */
  async listAvailableTenantIds(): Promise<string[]> {
    const rows = await this.directory.list();
    return rows
      .filter(({ directory, lifecycle }) => {
        try {
          this.assertAvailable({ directory, lifecycle });
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
    if (directory.status !== 'active') throw new TenantGateError('TENANT_NOT_READY');
    // A tenant Console has never activated is not ready rather than offline.
    if (!lifecycle || lifecycle.acceptedVersion === 0)
      throw new TenantGateError('TENANT_NOT_READY');
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

  private isFresh(fetchedAt: number, maxAgeMs: number) {
    return this.now().getTime() - fetchedAt < maxAgeMs;
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

    const key = `${directory.connectionVersion}|${directory.credentialBundleVersion}`;
    const cached = this.sessions.get(directory.tenantId);
    if (cached?.key === key) return cached.session;

    const { tenantId } = directory;
    const session = new TenantDatabaseSession({
      acquire: this.acquireFor(directory),
      admit: async () => {
        if (this.claims && !this.claims.isHeld(tenantId))
          throw new TenantGateError('TENANT_UNAVAILABLE');
        await this.assertAdmitted(tenantId, 0);
      },
      schemaName: directory.schemaName,
      tenantId,
    });
    this.sessions.set(tenantId, { key, session });
    return session;
  }

  /** Pool lease factory over the tenant's runtime credential. */
  private acquireFor(directory: DirectoryRow) {
    let password: string;
    try {
      password = openDirectoryData(
        directory.runtimeSecret,
        directorySecretAad(directory.tenantId, directory.credentialBundleVersion, 'runtime'),
      );
    } catch (cause) {
      throw new TenantGateError('TENANT_NOT_READY', undefined, {
        cause: new TenantDatabaseError('TENANT_NOT_READY', 'decrypt-failed', { cause }),
      });
    }

    const connection = {
      database: directory.database,
      host: directory.host,
      password,
      port: directory.port,
      ssl: directory.tls.enabled
        ? {
            rejectUnauthorized: directory.tls.rejectUnauthorized,
            ...(directory.tls.ca && { ca: directory.tls.ca }),
          }
        : false,
      user: directory.runtimeUsername,
    };
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
  private async openScope(directory: DirectoryRow): Promise<TenantScope> {
    const session = this.sessionFor(directory);
    const verifiedKey = `${directory.tenantId}|${directory.connectionVersion}|${directory.credentialBundleVersion}|${directory.schemaVersion}`;
    const checkedAt = this.verified.get(verifiedKey);
    if (checkedAt === undefined || !this.isFresh(checkedAt, TENANT_ADMISSION_TTL_MS)) {
      const startedAt = this.now().getTime();
      const lease = this.acquireFor(directory)();
      try {
        const client = await lease.pool.connect();
        try {
          await this.verifyDatabase(client, {
            schemaName: directory.schemaName,
            tenantId: directory.tenantId,
          });
        } finally {
          client.release();
        }
      } catch (cause) {
        log('tenant database verification failed for %s', directory.tenantId);
        throw new TenantGateError('TENANT_NOT_READY', undefined, { cause });
      } finally {
        lease.release();
      }
      if (!this.isFresh(startedAt, TENANT_ADMISSION_TTL_MS))
        throw new TenantGateError('TENANT_UNAVAILABLE');
      this.verified.set(verifiedKey, startedAt);
    }
    return { session, slug: directory.slug, tenantId: directory.tenantId };
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
