import { requireTenantScope } from '@lobechat/database/tenant';

/**
 * Object storage layout per tenant (spec FR-AS-04): every object lives under
 * `t/{tenantId}/`, followed by the key the application uses (`files/{date}/…`,
 * trace snapshots, avatars, …).
 *
 * The application, the database and the client keep working with that
 * logical key; only the storage boundary (`S3` and public-URL builders) maps
 * it to the physical key of the current tenant. A key handed in by a client
 * or read from the database can therefore never address another tenant's
 * object, and code without a tenant scope cannot reach storage at all.
 */
export const TENANT_OBJECT_PREFIX = 't';

const tenantObjectRoot = (tenantId: string) => {
  if (!tenantId || tenantId.includes('/')) throw new Error('TENANT_OBJECT_KEY_INVALID');
  return `${TENANT_OBJECT_PREFIX}/${tenantId}/`;
};

/** The current tenant's physical key for a logical key. */
export const tenantObjectKey = (key: string): string => {
  const root = tenantObjectRoot(requireTenantScope().tenantId);
  const logical = key.replace(/^\/+/, '');
  if (!logical) throw new Error('TENANT_OBJECT_KEY_INVALID');
  return `${root}${logical}`;
};

/**
 * The logical key of a physical key read back from a URL. Returns `null` when
 * the key does not belong to the current tenant (another tenant's object, or
 * one stored before tenant prefixes): such a URL is not resolved.
 */
export const logicalObjectKey = (physicalKey: string): string | null => {
  const root = tenantObjectRoot(requireTenantScope().tenantId);
  const key = physicalKey.replace(/^\/+/, '');
  if (!key.startsWith(root)) return null;
  const logical = key.slice(root.length);
  return logical || null;
};
