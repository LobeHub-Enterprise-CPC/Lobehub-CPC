import { LOBEHUB_TENANT_SCHEMA_VERSION } from '@lobechat/database/tenant';

/**
 * `GET tenant-manifest`: what a new tenant is bound to. Console reads it before it builds a
 * tenant's credential bundle, so a new schema version needs a new build and nothing else; there
 * is no matching setting to keep in step on Console's side.
 */
export interface TenantManifest {
  schemaVersion: number;
}

export const tenantManifest = (): TenantManifest => ({
  schemaVersion: LOBEHUB_TENANT_SCHEMA_VERSION,
});
