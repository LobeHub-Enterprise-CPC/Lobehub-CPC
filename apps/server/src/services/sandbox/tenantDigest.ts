import { createHash } from 'node:crypto';

import { currentTenantScope } from '@lobechat/database/tenant';

/**
 * The tenant dimension of a persistent-sandbox key: the first 128 bits of the
 * SHA-256 of the tenant id, as 32 lowercase hex characters. A hash rather than
 * the id itself because tenant ids may contain characters a directory name
 * cannot (`:`) and have no length bound of their own, while the key has both.
 * `undefined` outside a tenant scope, which keeps the untenanted key shape.
 */
export const sandboxTenantDigest = (): string | undefined => {
  const tenantId = currentTenantScope()?.tenantId;
  if (!tenantId) return undefined;

  return createHash('sha256').update(tenantId, 'utf8').digest('hex').slice(0, 32);
};
