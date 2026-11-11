import { parseTenantPath } from '@lobechat/business-tenant/routing';

import { appOrigins } from './memoryRoute';

/** File job routes below a tenant prefix: `/orgs/{slug}/api/workflows/file/…`. */
export const FILE_WORKFLOW_PATH = '/api/workflows/file/';

/** Whether `url` is a file job delivery to this app. */
export const isFileJobDelivery = (url: URL): boolean => {
  if (!appOrigins().includes(url.origin)) return false;
  const { rest, tenantSlug } = parseTenantPath(url.pathname);
  return !!tenantSlug && rest.startsWith(FILE_WORKFLOW_PATH);
};
