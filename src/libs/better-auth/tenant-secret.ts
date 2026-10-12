import { hkdfSync } from 'node:crypto';

import { authEnv } from '@/envs/auth';

/**
 * Per-tenant better-auth secret.
 *
 * Every artifact better-auth signs or encrypts (signed session token, the
 * `session_data` cache cookie, OAuth state, email verification and change-email
 * tokens, …) is bound to `ctx.context.secret`. A secret shared by all tenants
 * lets tenant A's artifact be replayed on tenant B, e.g. by renaming a cookie
 * to B's prefix; the cookie cache even accepts it without a database lookup.
 * So each tenant's instance gets its own key:
 *
 *   HKDF-SHA256(ikm = AUTH_SECRET, salt = empty, info = "lobehub:tenant-auth:" + tenantId, 32)
 *
 * The info string is distinct from the tenant data key's
 * (`lobehub:tenant-data:`), so the two keys are unrelated. The key is encoded
 * as base64url (43 characters) because better-auth takes a string secret.
 */
export const TENANT_AUTH_SECRET_INFO_PREFIX = 'lobehub:tenant-auth:';

export const deriveTenantAuthSecret = (
  tenantId: string,
  masterSecret: string | undefined = authEnv.AUTH_SECRET,
): string => {
  if (!tenantId) throw new Error('A tenant id is required to derive the auth secret');
  if (!masterSecret) throw new Error('AUTH_SECRET is required to derive the tenant auth secret');

  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterSecret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(`${TENANT_AUTH_SECRET_INFO_PREFIX}${tenantId}`, 'utf8'),
      32,
    ),
  ).toString('base64url');
};
