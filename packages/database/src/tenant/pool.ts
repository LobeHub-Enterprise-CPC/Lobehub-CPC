import { createHash } from 'node:crypto';

import { Pool, type PoolConfig } from 'pg';

import { TenantDatabaseError } from './errors';
import { isTenantSchemaName } from './names';

/**
 * Connection pools for tenant databases (spec FR-DI-05), after Admin's
 * `TenantPoolManager`. A pool is keyed by tenant + purpose + schema +
 * connection version + credential fingerprint; a newer connection version
 * retires the old pool, which closes once its last lease is returned. Owner
 * (maintenance) and runtime (request) connections never share a pool.
 */

export type TenantPoolPurpose = 'maintenance' | 'request';

export interface TenantConnectionTarget {
  database: string;
  host: string;
  password: string;
  port: number;
  ssl?: PoolConfig['ssl'];
  user: string;
}

export interface TenantPoolConfig {
  connection: TenantConnectionTarget;
  connectionVersion: number;
  purpose: TenantPoolPurpose;
  schemaName: string;
  tenantId: string;
}

export interface TenantPoolLease {
  pool: Pool;
  release: () => void;
}

/** Hash of everything that identifies a physical connection, password included. */
export const fingerprintConnection = (connection: TenantConnectionTarget) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        connection.host,
        connection.port,
        connection.database,
        connection.user,
        connection.password,
        connection.ssl ?? null,
      ]),
    )
    .digest('hex');

type ManagedPool = {
  closing: boolean;
  drained: Promise<void>;
  finish: () => void;
  lastUsedAt: number;
  leases: number;
  pool: Pool;
  retired: boolean;
  routeKey: string;
};

export interface TenantPoolManagerOptions {
  createPool?: (config: PoolConfig) => Pool;
  idleTimeoutMs?: number;
  maxConnectionsPerPool?: number;
  maxPools?: number;
  onPoolError?: (event: { phase: 'close' | 'idle' }) => void;
  /** Per-connection `statement_timeout` / `idle_in_transaction_session_timeout` (FR-DI-06). */
  statementTimeoutMs?: number;
}

export class TenantPoolManager {
  private readonly entries = new Map<string, ManagedPool>();
  // Credential-free watermark per route so an old session cannot revive an old version.
  private readonly routes = new Map<string, { key?: string; version: number }>();
  private readonly createPool: (config: PoolConfig) => Pool;
  private readonly idleTimeoutMs: number;
  private readonly maxConnectionsPerPool: number;
  private readonly maxPools: number;
  private readonly onPoolError: (event: { phase: 'close' | 'idle' }) => void;
  private readonly statementTimeoutMs: number;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: TenantPoolManagerOptions = {}) {
    this.maxConnectionsPerPool = options.maxConnectionsPerPool ?? 4;
    this.maxPools = options.maxPools ?? 32;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    for (const value of [
      this.maxConnectionsPerPool,
      this.maxPools,
      this.idleTimeoutMs,
      this.statementTimeoutMs,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('Tenant pool limits must be positive safe integers.');
    }
    this.createPool = options.createPool ?? ((config) => new Pool(config));
    this.onPoolError =
      options.onPoolError ??
      ((event) => {
        console.error('[tenant-pool] connection pool error', event);
      });
  }

  acquire(config: TenantPoolConfig): TenantPoolLease {
    if (this.closed) throw new TenantDatabaseError('TENANT_UNAVAILABLE', 'pool-closed');
    if (!isTenantSchemaName(config.schemaName))
      throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-name-invalid');
    if (!Number.isSafeInteger(config.connectionVersion) || config.connectionVersion < 1)
      throw new TenantDatabaseError('TENANT_NOT_READY', 'stale-connection-version');

    const key = JSON.stringify([
      config.tenantId,
      config.purpose,
      config.schemaName,
      config.connectionVersion,
      fingerprintConnection(config.connection),
    ]);
    const routeKey = JSON.stringify([config.tenantId, config.purpose]);
    const current = this.routes.get(routeKey);
    if (
      current &&
      (config.connectionVersion < current.version ||
        (config.connectionVersion === current.version && current.key && current.key !== key))
    )
      throw new TenantDatabaseError('TENANT_UNAVAILABLE', 'stale-connection-version');
    this.routes.set(routeKey, { key, version: config.connectionVersion });

    // A newer version (or new credentials) retires the route's older pools.
    for (const [entryKey, entry] of this.entries)
      if (entry.routeKey === routeKey && entryKey !== key) this.retire(entryKey, entry);

    let entry = this.entries.get(key);
    if (entry?.retired)
      throw new TenantDatabaseError('TENANT_UNAVAILABLE', 'stale-connection-version');
    if (!entry) {
      this.evictIdlePools();
      if (this.entries.size >= this.maxPools)
        throw new TenantDatabaseError('TENANT_UNAVAILABLE', 'capacity');
      const { connection } = config;
      const pool = this.createPool({
        allowExitOnIdle: true,
        connectionTimeoutMillis: 10_000,
        database: connection.database,
        host: connection.host,
        idle_in_transaction_session_timeout: this.statementTimeoutMs,
        idleTimeoutMillis: 30_000,
        max: this.maxConnectionsPerPool,
        password: connection.password,
        port: connection.port,
        ssl: connection.ssl,
        statement_timeout: this.statementTimeoutMs,
        user: connection.user,
      });
      let finish!: () => void;
      const drained = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const created: ManagedPool = {
        closing: false,
        drained,
        finish,
        lastUsedAt: Date.now(),
        leases: 0,
        pool,
        retired: false,
        routeKey,
      };
      pool.on('error', () => this.reportError('idle'));
      this.entries.set(key, created);
      entry = created;
    }

    const leased = entry;
    leased.leases += 1;
    this.scheduleSweep();
    let released = false;
    return {
      pool: leased.pool,
      release: () => {
        if (released) return;
        released = true;
        leased.leases -= 1;
        leased.lastUsedAt = Date.now();
        if (leased.retired && leased.leases === 0) this.closeEntry(key, leased);
        this.scheduleSweep();
      },
    };
  }

  /** Retires every pool of a tenant (rotation, offline); active leases drain first. */
  invalidateTenant(tenantId: string) {
    for (const [key, entry] of this.entries)
      if (JSON.parse(entry.routeKey)[0] === tenantId) this.retire(key, entry);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const entries = [...this.entries.entries()];
    for (const [key, entry] of entries) this.retire(key, entry);
    await Promise.all(entries.map(([, entry]) => entry.drained));
  }

  get size() {
    return this.entries.size;
  }

  private retire(key: string, entry: ManagedPool) {
    entry.retired = true;
    if (entry.leases === 0) this.closeEntry(key, entry);
  }

  private closeEntry(key: string, entry: ManagedPool) {
    if (entry.closing) return;
    entry.closing = true;
    // A failed close keeps its capacity slot: its connections may still be open.
    const finish = (failed: boolean) => {
      if (failed) this.reportError('close');
      else this.entries.delete(key);
      entry.finish();
    };
    try {
      void entry.pool.end().then(
        () => finish(false),
        () => finish(true),
      );
    } catch {
      finish(true);
    }
  }

  private evictIdlePools(makeRoom = true) {
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => !entry.retired && entry.leases === 0)
      .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt);
    for (const [key, entry] of idle)
      if (Date.now() - entry.lastUsedAt >= this.idleTimeoutMs) this.retire(key, entry);
    if (makeRoom && this.entries.size >= this.maxPools) {
      const oldest = idle.find(([, entry]) => !entry.retired);
      if (oldest) this.retire(...oldest);
    }
  }

  private scheduleSweep() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    const idle = [...this.entries.values()].filter((e) => !e.retired && e.leases === 0);
    if (idle.length === 0) return;
    const delay = Math.max(
      1,
      Math.min(...idle.map((e) => e.lastUsedAt + this.idleTimeoutMs - Date.now())),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.evictIdlePools(false);
      this.scheduleSweep();
    }, delay);
    this.timer.unref?.();
  }

  private reportError(phase: 'close' | 'idle') {
    try {
      this.onPoolError({ phase });
    } catch {
      // Observability must not break draining or escape pg's background error handler.
    }
  }
}
