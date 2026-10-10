import { withTenantPath } from '@lobechat/business-tenant/routing';

import { tenantDbNames } from '../../../packages/database/src/tenant/names';

// Shared by provisioning, SQL fixtures and browser/API navigation. Worker users
// remain isolated by seedTestUser's run/worker suffix within this test tenant.
export const E2E_TENANT = {
  id: `e2e-${process.env.E2E_RUN_ID || process.env.GITHUB_RUN_ID || 'local'}`,
  slug: 'e2e',
};

export const tenantPath = (path: string) => withTenantPath(path, E2E_TENANT.slug);

export const tenantClientConfig = (connectionString: string) => ({
  connectionString,
  options: `-c search_path=${tenantDbNames(E2E_TENANT.id).schemaName},extensions,paradedb`,
});
