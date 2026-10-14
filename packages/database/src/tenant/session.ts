import { AsyncLocalStorage } from 'node:async_hooks';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import * as schema from '../schemas';
import type { LobeChatDatabase, Transaction } from '../type';
import { TenantDatabaseError } from './errors';
import { tenantTransactionPreludeSql } from './names';
import type { TenantPoolLease } from './pool';

/**
 * Admission check hook. `early` runs before a connection is taken and may be
 * answered from bounded-staleness facts; `locked` runs once the tenant's shared
 * drain lock is held and must reflect the state at that moment (FR-DI-07).
 */
export type TenantAdmit = (stage: 'early' | 'locked') => Promise<void>;

/** Keep checked-out pg errors local; the owning operation still performs its final release. */
export const observeBorrowedClientErrors = (client: PoolClient) => {
  let failure: Error | undefined;
  const onError = (error: Error) => {
    failure ??= error;
  };
  client.on('error', onError);
  return {
    get error() {
      return failure;
    },
    release(error?: Error | boolean) {
      try {
        client.release(error || failure);
      } finally {
        client.removeListener('error', onError);
      }
    },
  };
};

const BEGIN_STATEMENT = /^\s*begin\b/i;
const statementText = (query: unknown): string =>
  typeof query === 'string' ? query : String((query as { text?: unknown } | null)?.text ?? '');

/**
 * A pg.Pool facade that pins every statement to one tenant schema (after
 * Admin's `createTenantSchemaPool`). Drizzle starts transactions with a
 * `begin` on a `connect()` client; the facade follows it with the tenant
 * prelude: transaction-local search_path plus the tenant's shared drain lock
 * (FR-DI-07), then the optional admission check. A statement sent straight to the pool runs in its
 * own short transaction with the same guard. Transaction-local search_path is
 * reset at commit / rollback, so a pooled connection never carries one
 * tenant's path into another tenant's work (FR-DI-06, AC-04-6).
 */
export const createTenantSchemaPool = (
  acquire: () => TenantPoolLease,
  schemaName: string,
  tenantId: string,
  admit?: TenantAdmit,
): Pool => {
  const prelude = tenantTransactionPreludeSql(schemaName, tenantId);
  const pool = new Pool({ max: 1 });

  const connect = async (): Promise<PoolClient> => {
    // Refuse early, before taking a pooled connection, when the tenant is
    // already known to be unavailable.
    if (admit) await admit('early');
    const lease = acquire();
    let client: PoolClient;
    try {
      client = await lease.pool.connect();
    } catch (cause) {
      lease.release();
      throw new TenantDatabaseError('TENANT_UNAVAILABLE', 'connect-failed', { cause });
    }
    const observation = observeBorrowedClientErrors(client);
    let released = false;
    const release = (error?: Error | boolean) => {
      if (released) return;
      released = true;
      observation.release(error);
      lease.release();
    };
    /**
     * Runs after BEGIN. Once the shared drain lock is held, admission is
     * checked again: work that waited for a connection or for a drain to
     * finish must not start after the freeze it waited behind (FR-DI-07).
     * Drizzle issues BEGIN outside its try/finally, so a refusal here rolls
     * back and returns the connection itself.
     */
    const guard = async () => {
      try {
        await client.query(prelude);
        if (admit) await admit('locked');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
          release();
        } catch (rollbackError) {
          // An unusable connection is discarded rather than pooled.
          release(rollbackError as Error);
        }
        throw error;
      }
    };
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') {
          return async (...args: unknown[]) => {
            // Once returned to the pool the connection may belong to another
            // caller: nothing may run on it through this handle any more.
            if (released)
              throw new TenantDatabaseError('TENANT_UNAVAILABLE', 'connection-released');
            if (observation.error) throw observation.error;
            const result: unknown = await Reflect.apply(target.query, target, args);
            if (BEGIN_STATEMENT.test(statementText(args[0]))) await guard();
            return result;
          };
        }
        if (property === 'release') return release;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const query = async (...args: unknown[]) => {
    const client = await connect();
    try {
      await client.query('BEGIN');
      const result = await (client.query as (...input: unknown[]) => Promise<unknown>)(...args);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  Object.assign(pool, { connect, end: async () => undefined, query });
  return pool;
};

export interface TenantDatabaseSessionConfig {
  acquire: () => TenantPoolLease;
  /**
   * Called twice for every transaction or standalone statement (before the
   * connection, and after the drain lock); a rejection refuses the work. The
   * tenant runtime re-checks the tenant's lifecycle here.
   */
  admit?: TenantAdmit;
  schemaName: string;
  tenantId: string;
}

/**
 * One tenant's runtime database. `database` is a Drizzle handle whose every
 * statement runs inside the tenant schema; `run` groups work in one tenant
 * transaction and reuses an outer one (FR-DI-06 nesting).
 */
export class TenantDatabaseSession {
  private readonly transactionStorage = new AsyncLocalStorage<Transaction>();
  private pinned?: LobeChatDatabase;

  constructor(private readonly config: TenantDatabaseSessionConfig) {}

  get tenantId() {
    return this.config.tenantId;
  }

  get schemaName() {
    return this.config.schemaName;
  }

  get database(): LobeChatDatabase {
    this.pinned ??= drizzle(
      createTenantSchemaPool(
        this.config.acquire,
        this.config.schemaName,
        this.config.tenantId,
        this.config.admit,
      ),
      { schema },
    ) as unknown as LobeChatDatabase;
    return this.pinned;
  }

  async run<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const active = this.transactionStorage.getStore();
    if (active) return operation(active);
    return this.database.transaction((tx) => this.transactionStorage.run(tx, () => operation(tx)));
  }
}
