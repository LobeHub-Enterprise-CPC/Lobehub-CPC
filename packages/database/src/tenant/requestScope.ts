import { AsyncLocalStorage } from 'node:async_hooks';

import type { LobeChatDatabase } from '../type';
import { TenantDatabaseError } from './errors';
import type { TenantDatabaseSession } from './session';

/**
 * The tenant a unit of work belongs to: a request that passed tenant
 * admission, or a job that re-established its tenant from a trusted payload
 * (spec FR-ID-07, FR-AS-01). Only the admission layer creates one.
 *
 * Nothing here says how the tenant was addressed (path prefix today, Host
 * later, spec A17): auth, sessions and business code only see this scope.
 */
export interface TenantScope {
  readonly session: TenantDatabaseSession;
  readonly slug: string;
  readonly tenantId: string;
}

const storage = new AsyncLocalStorage<TenantScope>();

/** Binds `scope` to everything awaited inside `operation`. */
export const runWithTenantScope = <T>(scope: TenantScope, operation: () => T): T =>
  storage.run(scope, operation);

export const currentTenantScope = (): TenantScope | undefined => storage.getStore();

/** The current tenant, or a `TENANT_REQUIRED` failure: there is no default tenant. */
export const requireTenantScope = (): TenantScope => {
  const scope = storage.getStore();
  if (!scope) throw new TenantDatabaseError('TENANT_REQUIRED', 'no-scope');
  return scope;
};

/**
 * The business database for the current tenant. Every property access resolves
 * the scope at call time and fails closed without one, so a code path that
 * never established a tenant cannot reach any business or auth table, and a
 * handle kept across requests still follows the request it is used in.
 */
/**
 * Properties that callers probe without meaning to use the database: promise
 * resolution (`then`), inspection, and test-matcher checks. Outside a scope
 * they read as absent instead of failing; every real use still fails closed.
 */
const isIntrospection = (property: string | symbol) =>
  typeof property === 'symbol' ||
  property === 'then' ||
  property === 'toJSON' ||
  property === 'asymmetricMatch' ||
  property === '$$typeof' ||
  property === 'nodeType';

export const tenantDB: LobeChatDatabase = new Proxy({} as LobeChatDatabase, {
  get(_target, property) {
    // Never a thenable: `async () => tenantDB` must not resolve the tenant.
    if (property === 'then') return undefined;
    const scope = currentTenantScope();
    if (!scope && isIntrospection(property)) return undefined;
    const database = (scope ?? requireTenantScope()).session.database;
    const value = Reflect.get(database, property, database);
    return typeof value === 'function' ? value.bind(database) : value;
  },
  has(_target, property) {
    const scope = currentTenantScope();
    if (!scope && isIntrospection(property)) return false;
    return Reflect.has((scope ?? requireTenantScope()).session.database, property);
  },
});
