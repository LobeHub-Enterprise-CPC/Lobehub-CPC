import { findSlugEndpoint } from './endpoints';
import { TENANT_ROUTE_HEADER, verifyTenantRoute } from './routeHeader';

/**
 * Same-origin HTML bootstraps public routing context and the organization's display name,
 * only after the proxy signed its tenant.
 */
export const getTenantPageBootstrap = async (request: Request) => {
  const slug = verifyTenantRoute(request.headers.get(TENANT_ROUTE_HEADER));
  if (!slug) return undefined;
  const entry = await findSlugEndpoint(slug);
  if (!entry) return undefined;
  const url = new URL(entry.state.activeUrl);
  return {
    // The directory name is display text; the page falls back to the slug without it.
    ...(entry.name ? { name: entry.name } : {}),
    // Links written before a rename carry these; the page still treats them as its own.
    ...(entry.formerSlugs.length ? { formerSlugs: entry.formerSlugs } : {}),
    publicUrl: entry.state.activeUrl,
    version: entry.state.appliedVersion,
    basePath: url.pathname === '/' ? '' : url.pathname,
    slug,
  };
};
