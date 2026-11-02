import { type LobeChatDatabase } from '@lobechat/database';
import { currentTenantScope } from '@lobechat/database/tenant';
import { MARKET_TRUSTED_CLIENT_ORG_UNIT_LIMIT } from '@lobehub/market-types';

import { UserModel } from '@/database/models/user';

import {
  isSyntheticTrustedClientUserId,
  isTenantMarketMode,
  isTrustedClientEnabled,
} from './config';
import { TrustedClientIdentityError } from './errors';
import { type TrustedClientUserInfo } from './index';

export interface ResolveTrustedClientIdentityParams extends Pick<
  TrustedClientUserInfo,
  'email' | 'name' | 'proxyExecution' | 'sandboxStorage' | 'workspaceId'
> {
  /** Defaults to the current tenant's business database. */
  serverDB?: LobeChatDatabase;
  userId: string;
}

const getDB = async (serverDB?: LobeChatDatabase) =>
  serverDB ?? (await (await import('@/database/server')).getServerDB());

/** One lookup per member per tenant scope (a request), however many Market clients it builds. */
const orgUnitCache = new WeakMap<object, Map<string, Promise<string[]>>>();

/**
 * The tenant member's department chain for the trust token. A chain Market would refuse (over the
 * claim limit) is reported, never cut: a shorter chain would silently lose ancestor grants.
 */
const resolveOrgUnitIds = (userId: string, serverDB?: LobeChatDatabase): Promise<string[]> => {
  const scope = currentTenantScope();
  const cached = scope ? orgUnitCache.get(scope)?.get(userId) : undefined;
  if (cached) return cached;
  const lookup = (async () => {
    let chain: string[];
    try {
      // Loaded on first use: a distribution's auth package carries its whole session stack, which
      // identity assembly does not otherwise need.
      const { resolveBusinessOrgUnitIds } = await import('@lobechat/business-auth');
      chain = await resolveBusinessOrgUnitIds(
        await getDB(serverDB),
        userId,
        MARKET_TRUSTED_CLIENT_ORG_UNIT_LIMIT,
      );
    } catch (error) {
      throw new TrustedClientIdentityError('ORG_UNITS_UNAVAILABLE', { cause: error });
    }
    if (chain.length > MARKET_TRUSTED_CLIENT_ORG_UNIT_LIMIT) {
      console.error(
        '[trusted-client] department chain of %s exceeds %d levels; refusing to sign',
        userId,
        MARKET_TRUSTED_CLIENT_ORG_UNIT_LIMIT,
      );
      throw new TrustedClientIdentityError('ORG_UNITS_UNAVAILABLE');
    }
    return chain;
  })();
  if (scope) {
    const perScope = orgUnitCache.get(scope) ?? new Map<string, Promise<string[]>>();
    perScope.set(userId, lookup);
    orgUnitCache.set(scope, perScope);
    // A failed lookup is not remembered: the next client in the request retries it.
    lookup.catch(() => perScope.delete(userId));
  }
  return lookup;
};

/**
 * The one place a Market identity is assembled: `{ userId, email, name, tenantId }`
 * plus whatever the caller routes with (workspace, sandbox claim).
 *
 * `tenantId` is `requireTenantScope().tenantId` read at assembly time and then
 * carried on the identity, so it survives into places that run outside the
 * request (receipts, queued steps) without being re-derived there.
 *
 * Three outcomes, kept apart on purpose:
 * - no tenant and trusted client not enabled, or a synthetic eval/smoke user:
 *   `undefined` — the deployment simply has no trust-token path for this caller;
 * - trusted client enabled and the identity assembled: the identity;
 * - tenant mode and it cannot be assembled (trusted client not configured, no
 *   tenant scope, user row gone, no email): {@link TrustedClientIdentityError}. Never `undefined`, so
 *   the caller cannot mistake "failed" for "not configured" and fall back to an
 *   OIDC user or an unauthenticated request.
 *
 * When trusted client is not enabled the legacy shape is preserved: a best-effort
 * identity, `undefined` if the user cannot be read.
 */
export const resolveTrustedClientIdentity = async ({
  email,
  name,
  proxyExecution,
  sandboxStorage,
  serverDB,
  userId,
  workspaceId,
}: ResolveTrustedClientIdentityParams): Promise<TrustedClientUserInfo | undefined> => {
  // Tenant mode, not just "configured": a tenant scope without a usable trusted
  // client has no way to reach Market as this user, and says so.
  const enforced = isTenantMarketMode();
  if (enforced && isSyntheticTrustedClientUserId(userId)) return undefined;
  if (enforced && !isTrustedClientEnabled()) {
    throw new TrustedClientIdentityError('TRUST_NOT_CONFIGURED');
  }

  const tenantId = currentTenantScope()?.tenantId;
  if (enforced && !tenantId) throw new TrustedClientIdentityError('TENANT_REQUIRED');

  let resolvedEmail = email;
  let resolvedName = name;

  if (!resolvedEmail) {
    try {
      const user = await UserModel.findById(await getDB(serverDB), userId);
      resolvedEmail = user?.email ?? undefined;
      resolvedName = resolvedName ?? user?.fullName ?? user?.username ?? undefined;
    } catch (error) {
      if (enforced) throw new TrustedClientIdentityError('USER_UNAVAILABLE', { cause: error });
      return undefined;
    }

    if (!resolvedEmail) {
      if (enforced) throw new TrustedClientIdentityError('USER_UNAVAILABLE');
      return undefined;
    }
  }

  // Only tenant tokens may carry a chain (Market refuses one elsewhere).
  const orgUnitIds = tenantId ? await resolveOrgUnitIds(userId, serverDB) : undefined;

  return {
    email: resolvedEmail,
    name: resolvedName,
    userId,
    ...(orgUnitIds ? { orgUnitIds } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(proxyExecution ? { proxyExecution } : {}),
    ...(sandboxStorage ? { sandboxStorage } : {}),
    // Acting as the workspace's organization is closed inside a tenant (R13):
    // the workspace is not part of a tenant identity. Outside a tenant it stays.
    ...(workspaceId && !isTenantMarketMode() ? { workspaceId } : {}),
  };
};

/**
 * {@link resolveTrustedClientIdentity} for callers that always build a
 * `MarketService` (runtimes, background jobs): when the identity is "not
 * applicable" (trusted client off, synthetic eval user) they still get the bare
 * `{ userId, … }` they have always passed, so receipts and caches keep their
 * scope. Assembly failures still throw.
 */
export const resolveMarketServiceIdentity = async (
  params: ResolveTrustedClientIdentityParams,
): Promise<TrustedClientUserInfo> => {
  const identity = await resolveTrustedClientIdentity(params);
  if (identity) return identity;

  const { proxyExecution, sandboxStorage, userId, workspaceId } = params;
  return {
    userId,
    ...(proxyExecution ? { proxyExecution } : {}),
    ...(sandboxStorage ? { sandboxStorage } : {}),
    ...(workspaceId && !isTenantMarketMode() ? { workspaceId } : {}),
  };
};
