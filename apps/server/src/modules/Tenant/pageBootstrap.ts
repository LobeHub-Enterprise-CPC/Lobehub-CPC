import { findSlugEndpoint } from './endpoints';
import { TENANT_ROUTE_HEADER, verifyTenantRoute } from './routeHeader';

/** Same-origin HTML bootstraps public routing context only after the proxy signed its tenant. */
export const getTenantPageBootstrap = async (request: Request) => {
  const slug = verifyTenantRoute(request.headers.get(TENANT_ROUTE_HEADER));
  if (!slug) return undefined;
  const entry = await findSlugEndpoint(slug);
  if (!entry) return undefined;
  const url = new URL(entry.state.activeUrl);
  return {
    publicUrl: entry.state.activeUrl,
    version: entry.state.appliedVersion,
    basePath: url.pathname === '/' ? '' : url.pathname,
    slug,
  };
};
