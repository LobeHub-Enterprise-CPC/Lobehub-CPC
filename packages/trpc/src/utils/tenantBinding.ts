import { requireTenantScope } from '@lobechat/database/tenant/requestScope';

/**
 * Every tenant shares one signing key (`JWKS_KEY`), so a signature alone cannot
 * say which tenant a token was minted for. Each token carries the tenant id in
 * this signed claim and is only honoured by the tenant that matches it.
 *
 * The id (not the slug) is the binding: the slug is a mutable address, the id is
 * what `requireTenantScope()` resolves a request or job to.
 */
export const TENANT_ID_CLAIM = 'tid';

/**
 * The claim to merge into a token's payload at signing time. Fails closed with
 * `TENANT_REQUIRED` outside a tenant scope: a token without an owner could
 * never be verified.
 */
export const currentTenantClaim = (): { [TENANT_ID_CLAIM]: string } => ({
  [TENANT_ID_CLAIM]: requireTenantScope().tenantId,
});

/** True only when the verified payload names the tenant this request/job runs in. */
export const isBoundToCurrentTenant = (payload: Record<string, unknown>): boolean => {
  const tenantId = payload[TENANT_ID_CLAIM];
  return typeof tenantId === 'string' && tenantId === requireTenantScope().tenantId;
};
