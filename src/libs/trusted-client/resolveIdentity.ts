import { type LobeChatDatabase } from '@lobechat/database';
import { currentTenantScope } from '@lobechat/database/tenant';

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
      const db = serverDB ?? (await (await import('@/database/server')).getServerDB());
      const user = await UserModel.findById(db, userId);
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

  return {
    email: resolvedEmail,
    name: resolvedName,
    userId,
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
