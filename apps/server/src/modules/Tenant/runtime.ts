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
import { directorySecretAad } from '@/server/services/tenantControlPlane/postgresRepository';
import { effectiveTenantState } from '@/server/services/tenantControlPlane/service';

import type { TenantDirectoryEntry } from './directoryRepository';
import { TenantDirectoryRepository } from './directoryRepository';
import { TenantGateError } from './errors';

const log = debug('lobe-server:tenant');

type DirectoryRow = TenantDirectoryEntry['directory'];

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
  private readonly sessions = new Map<string, { key: string; session: TenantDatabaseSession }>();
  /** Pools whose marker was read successfully, by pool identity. */
  private readonly verified = new Set<string>();

  constructor(
    platform: () => PlatformDatabase,
    private readonly pools: TenantPoolManager,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.directory = new TenantDirectoryRepository(platform);
  }

  /** Drops cached routing facts and sessions for a tenant (lifecycle stage 1, rotation). */
  invalidate(tenantId: string) {
    this.directory.invalidate();
    this.sessions.delete(tenantId);
    for (const key of this.verified) if (key.startsWith(`${tenantId}|`)) this.verified.delete(key);
  }

  /** Request entry: resolve, check lifecycle, open the tenant database. */
  async admitSlug(slug: string): Promise<TenantScope> {
    const entry = await this.directory.findBySlug(slug);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    this.assertAvailable(entry);
    return this.openScope(entry.directory);
  }

  /** Job entry (FR-AS-01): the tenant id came from a verified payload. */
  async admitTenantId(tenantId: string): Promise<TenantScope> {
    const entry = await this.directory.findById(tenantId);
    if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
    this.assertAvailable(entry);
    return this.openScope(entry.directory);
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
    const session = this.sessionFor(entry.directory);
    const key = tenantDrainLockKey(tenantId);
    await session.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    });
  }

  private assertAvailable(entry: TenantDirectoryEntry) {
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
    const session = new TenantDatabaseSession({
      acquire: () =>
        this.pools.acquire({
          connection,
          connectionVersion: directory.connectionVersion,
          purpose: 'request',
          schemaName: directory.schemaName,
          tenantId: directory.tenantId,
        }),
      schemaName: directory.schemaName,
      tenantId: directory.tenantId,
    });
    this.sessions.set(directory.tenantId, { key, session });
    return session;
  }

  /**
   * Opens the tenant scope. The first use of a connection version reads the
   * marker through the runtime role (FR-DI-04): a directory entry pointing at
   * another tenant's schema is refused before any business query runs.
   */
  private async openScope(directory: DirectoryRow): Promise<TenantScope> {
    const session = this.sessionFor(directory);
    const verifiedKey = `${directory.tenantId}|${directory.connectionVersion}|${directory.credentialBundleVersion}`;
    if (!this.verified.has(verifiedKey)) {
      let rows: { schema_version: string }[];
      try {
        const result = await session.database.execute<{ schema_version: string }>(
          sql`SELECT schema_version FROM tenant_metadata WHERE tenant_id = ${directory.tenantId} AND datasource_kind = 'lobehub'`,
        );
        rows = result.rows;
      } catch (cause) {
        log('tenant marker read failed for %s', directory.tenantId);
        throw new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause });
      }
      if (rows.length !== 1 || rows[0].schema_version !== String(directory.schemaVersion))
        throw new TenantGateError('TENANT_NOT_READY', undefined, {
          cause: new TenantDatabaseError(
            'TENANT_NOT_READY',
            rows.length === 0 ? 'marker-missing' : 'marker-mismatch',
          ),
        });
      this.verified.add(verifiedKey);
    }
    return { session, slug: directory.slug, tenantId: directory.tenantId };
  }
}

let runtime: TenantRuntime | null = null;

/** The process-wide tenant runtime over the platform database. */
export const getTenantRuntime = (): TenantRuntime => {
  runtime ??= new TenantRuntime(getPlatformDB, new TenantPoolManager());
  return runtime;
};
