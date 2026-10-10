import { SUPPORTED_TENANT_SCHEMA_VERSIONS, tenantDbNames } from '@lobechat/database/tenant';

import type { DatasourceBundle, SafeErrorCode } from './contracts';

/**
 * Checks on a credential bundle Console sends (spec FR-CP-04 `validate`,
 * FR-CP-05, FR-CP-08). Everything here is pure: no database is touched, so a
 * bundle that fails is refused before any DB work.
 */

export { SUPPORTED_TENANT_SCHEMA_VERSIONS, tenantDbNames } from '@lobechat/database/tenant';

/**
 * The `validate` step: the bundle names this tenant, is a LobeHub bundle, uses
 * the names derived from the tenant id, targets a schema version this build
 * supports. The host is Console's call and is trusted as sent. Returns the
 * failure code or null.
 */
export const validateDatasourceBundle = (
  tenantId: string,
  bundle: DatasourceBundle,
): SafeErrorCode | null => {
  const names = tenantDbNames(tenantId);
  const ok =
    bundle.tenantId === tenantId &&
    bundle.datasourceKind === 'lobehub' &&
    bundle.schemaName === names.schemaName &&
    bundle.schemaOwner.username === names.ownerUsername &&
    bundle.schemaOwner.role === names.ownerUsername &&
    bundle.runtimeCredential.username === names.runtimeUsername &&
    SUPPORTED_TENANT_SCHEMA_VERSIONS.has(bundle.schemaVersion);
  return ok ? null : 'DATASOURCE_INVALID';
};

/** The bundle without its passwords: safe to digest, compare or log. */
export const redactDatasourceBundle = (bundle: DatasourceBundle) => ({
  ...bundle,
  runtimeCredential: { username: bundle.runtimeCredential.username },
  schemaOwner: { role: bundle.schemaOwner.role, username: bundle.schemaOwner.username },
});
