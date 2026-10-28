import { currentTenantScope } from '@lobechat/database/tenant';

import { appEnv } from '@/envs/app';

/**
 * Synthetic user ids used by local agent-evals / smoke scripts (e.g. `eval_*`,
 * `qstash_smoke_*`). These are never real platform accounts — no real userId
 * carries these prefixes — so Market rejects any trusted-client token built
 * from them with `invalid_trust_token / Invalid userId format`. We skip token
 * generation for them to avoid the doomed round-trip and the noisy prep drag it
 * causes during evals.
 */
const SYNTHETIC_USER_ID_PATTERN = /^(?:eval|qstash_smoke)_/;

export const isSyntheticTrustedClientUserId = (userId: string): boolean =>
  SYNTHETIC_USER_ID_PATTERN.test(userId);

/**
 * Check if trusted client authentication is enabled
 */
export const isTrustedClientEnabled = (): boolean => {
  return !!(appEnv.MARKET_TRUSTED_CLIENT_SECRET && appEnv.MARKET_TRUSTED_CLIENT_ID);
};

/**
 * Whether Market requests are made in tenant mode: a tenant scope is running,
 * or trusted client is enabled (every token then carries a tenantId).
 *
 * Market closes acting-as-organization for a tenant (R13): a tenant token must
 * not carry `workspaceId`, and the `x-lobe-owner-account-id` ("actAs") header,
 * the organization-scoped endpoints and the workspace-to-organization mapping
 * are refused. Community and single-tenant deployments (neither condition
 * holds) keep the original behaviour.
 */
export const isTenantMarketMode = (): boolean =>
  Boolean(currentTenantScope()) || isTrustedClientEnabled();
