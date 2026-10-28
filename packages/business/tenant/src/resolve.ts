import { hasTenantPrefix, parseTenantPath, withTenantPath } from './path';

/** Public routing context only; server admission establishes the trusted tenant identity. */
export interface TenantContext {
  readonly basePath: string;
  /** Slugs the tenant was renamed from, when bootstrapped by the server; links written under them are still its own. */
  readonly formerSlugs?: readonly string[];
  /** The organization's display name from the platform directory; absent when the server did not bootstrap it. */
  readonly name?: string;
  /** The tenant's active public address (`https://host/orgs/acme` or a custom domain), when bootstrapped by the server. */
  readonly publicUrl?: string;
  readonly slug: string;
}

/** Address resolution belongs here, so consumers do not depend on path-based tenancy. */
export const resolveTenant = (url: URL, bootstrap?: TenantContext | null): TenantContext | null => {
  if (bootstrap) {
    if (bootstrap.basePath === '') return hasTenantPrefix(url.pathname) ? null : bootstrap;
    const parsed = parseTenantPath(url.pathname);
    return parsed.tenantSlug === bootstrap.slug &&
      bootstrap.basePath === withTenantPath('/', bootstrap.slug)
      ? bootstrap
      : null;
  }
  const { tenantSlug } = parseTenantPath(url.pathname);
  return tenantSlug ? { basePath: withTenantPath('/', tenantSlug), slug: tenantSlug } : null;
};
