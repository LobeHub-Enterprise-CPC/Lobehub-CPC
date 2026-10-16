import type { SandboxStorageClaim } from '@lobechat/builtin-tool-cloud-sandbox';
import { currentTenantScope } from '@lobechat/database/tenant';
import {
  buildTrustedClientPayload,
  createTrustedClientToken,
  type TrustedClientPayload,
} from '@lobehub/market-sdk';

import { appEnv } from '@/envs/app';

import { isSyntheticTrustedClientUserId, isTenantMarketMode } from './config';
import { TrustedClientIdentityError } from './errors';

export interface TrustedClientUserInfo {
  email?: string;
  name?: string;
  /**
   * Set on an identity that is used while another principal's work runs under
   * it (an Agent Share visitor's run executes as the CREATOR). Never signed
   * into the token: it only lets {@link MarketService} refuse to publish
   * Market content with an identity nobody at the keyboard actually holds.
   */
  proxyExecution?: boolean;
  /**
   * Persistent-sandbox entitlement for this principal, resolved by
   * `resolveSandboxStorageClaim`. Absent — the shape every caller that does
   * not create sandboxes leaves it in — means the sandbox stays ephemeral.
   *
   * It rides the token rather than the request body on purpose: it is the one
   * thing the execution plane must not let a caller choose for itself.
   */
  sandboxStorage?: SandboxStorageClaim | null;
  /**
   * Tenant this identity belongs to (`requireTenantScope().tenantId` at the
   * moment it was assembled). Market opens the schema of that tenant's instance
   * for the request and resolves the account there by `userId` as it is, so a
   * token without the tenant cannot be signed and never falls back to the default
   * instance; see {@link generateTrustedClientToken}.
   *
   * Carried on the identity rather than read at signing time wherever the
   * identity outlives its request (the sandbox receipt that operator
   * reconciliation replays outside any tenant scope).
   */
  tenantId?: string;
  userId: string;
  /**
   * Cloud workspace the request runs in. Local routing context only: it is
   * never signed into a token, because a tenant closes acting-as-organization
   * (R13) and Market refuses a tenant token that names a workspace. Outside a
   * tenant (no scope, trusted client off) an identity may still carry it, as
   * before.
   */
  workspaceId?: string;
}

export {
  isSyntheticTrustedClientUserId,
  isTenantMarketMode,
  isTrustedClientEnabled,
} from './config';
export { TrustedClientIdentityError, type TrustedClientIdentityErrorCode } from './errors';
export { getSessionUser } from './getSessionUser';
export {
  resolveMarketServiceIdentity,
  resolveTrustedClientIdentity,
  type ResolveTrustedClientIdentityParams,
} from './resolveIdentity';

/**
 * `tenantId` is not on the published SDK's `TrustedClientPayload` (0.42.0), but
 * `createTrustedClientToken` encrypts whatever object it is handed and Market's
 * verifier reads the field off the decrypted payload. Local extension only; the
 * SDK package is not touched.
 */
export type TenantTrustedClientPayload = TrustedClientPayload & { tenantId?: string };

/** Market's `tenantId` claim: same character set as a path segment, at most 64 characters. */
const MARKET_TENANT_ID_PATTERN = /^[\w.-]{1,64}$/;

/**
 * The tenant a token is signed for. An identity that carries its tenant keeps
 * it (and must agree with the running scope, if there is one); otherwise it is
 * the tenant of the current scope. No scope and no carried tenant is a failure,
 * never an untenanted token.
 */
const resolveTokenTenantId = (userInfo: TrustedClientUserInfo): string => {
  const scopeTenantId = currentTenantScope()?.tenantId;
  const tenantId = userInfo.tenantId ?? scopeTenantId;

  if (!tenantId) throw new TrustedClientIdentityError('TENANT_REQUIRED');
  if (scopeTenantId && scopeTenantId !== tenantId) {
    throw new TrustedClientIdentityError('TENANT_MISMATCH');
  }
  if (!MARKET_TENANT_ID_PATTERN.test(tenantId)) {
    throw new TrustedClientIdentityError('TENANT_ID_UNSUPPORTED');
  }

  return tenantId;
};

/**
 * Generate trusted client token for a specific user
 * This token includes encrypted user info and is used for Market API authentication
 *
 * @param userInfo - User information (userId, email, name, tenantId)
 * @returns Encrypted token string, or undefined when no tenant is involved and
 *   trusted client is not configured (community / single-tenant deployments), or
 *   for a synthetic eval user
 * @throws {TrustedClientIdentityError} in tenant mode (a tenant scope is running,
 *   trusted client is configured, or the identity carries its tenant) when the
 *   token cannot be produced: `TRUST_NOT_CONFIGURED` (id or secret missing),
 *   `TRUST_SIGNING_FAILED` (the signer rejected them) or a tenant error. A
 *   request without a trust token reaches the default instance or is refused as
 *   a legacy Bearer, so "no token" is never an answer there.
 */
export const generateTrustedClientToken = (userInfo: TrustedClientUserInfo): string | undefined => {
  const { MARKET_TRUSTED_CLIENT_SECRET, MARKET_TRUSTED_CLIENT_ID } = appEnv;

  // Synthetic eval/smoke userIds can never be valid Market accounts; skip
  // signing a token Market is guaranteed to reject.
  if (isSyntheticTrustedClientUserId(userInfo.userId)) {
    return undefined;
  }

  if (!MARKET_TRUSTED_CLIENT_SECRET || !MARKET_TRUSTED_CLIENT_ID) {
    // Outside a tenant this is the community "trust is off" configuration. In
    // one it is a failure: the caller must not send the request unsigned.
    if (isTenantMarketMode() || userInfo.tenantId) {
      console.error('Trusted client token unavailable: %s', 'TRUST_NOT_CONFIGURED');
      throw new TrustedClientIdentityError('TRUST_NOT_CONFIGURED');
    }
    return undefined;
  }

  // Outside the try on purpose: an identity failure is an error for the caller,
  // not a reason to hand back "no token" the way a signing failure does.
  const tenantId = resolveTokenTenantId(userInfo);

  try {
    const payload = buildTrustedClientPayload({
      clientId: MARKET_TRUSTED_CLIENT_ID,
      // TODO: remove '' when sdk update
      email: userInfo.email || '',
      name: userInfo.name,
      userId: userInfo.userId,
      // No `workspaceId`: every token signed here carries a tenantId, and a
      // tenant closes acting-as-organization (R13), so Market refuses a tenant
      // token that names a workspace. Never forwarded, whatever the identity
      // carries.
    });

    // Attached after the builder rather than through it: the published SDK's
    // `buildTrustedClientPayload` still has a fixed parameter list that predates
    // this claim, while Market's verifier already reads it off the decrypted
    // payload. `createTrustedClientToken` signs whatever object it is handed, so
    // the field is covered by the signature exactly like the built-in ones.
    // Omitted when there is no entitlement, which is the free-tier shape and
    // leaves today's tokens unchanged.
    // TODO: pass through buildTrustedClientPayload once the SDK carries it.
    // `tenantId` is attached the same way and for the same reason; it is always
    // present, so Market admits the request into that tenant's own instance.
    const signedPayload: TenantTrustedClientPayload = {
      ...payload,
      ...(userInfo.sandboxStorage ? { sandboxStorage: userInfo.sandboxStorage } : {}),
      tenantId,
    };

    return createTrustedClientToken(signedPayload, MARKET_TRUSTED_CLIENT_SECRET);
  } catch {
    // Neither the error nor its message is logged or chained: the signer's
    // messages can quote the secret or the payload.
    console.error('Trusted client token unavailable: %s', 'TRUST_SIGNING_FAILED');
    throw new TrustedClientIdentityError('TRUST_SIGNING_FAILED');
  }
};

/**
 * Get trusted client token for the current session user
 * This is a convenience function that combines getSessionUser and generateTrustedClientToken
 *
 * @returns Encrypted token string or undefined if not configured or user not authenticated
 */
export const getTrustedClientTokenForSession = async (): Promise<string | undefined> => {
  const { getSessionUser } = await import('./getSessionUser');
  const userInfo = await getSessionUser();

  if (!userInfo) {
    return undefined;
  }

  return generateTrustedClientToken(userInfo);
};
