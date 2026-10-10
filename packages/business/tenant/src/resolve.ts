import { parseTenantPath, withTenantPath } from './path';

/** Public routing context only; server admission establishes the trusted tenant identity. */
export interface TenantContext {
  readonly basePath: string;
  readonly slug: string;
}

/** Address resolution belongs here, so consumers do not depend on path-based tenancy. */
export const resolveTenant = (url: URL): TenantContext | null => {
  const { tenantSlug } = parseTenantPath(url.pathname);
  return tenantSlug ? { basePath: withTenantPath('/', tenantSlug), slug: tenantSlug } : null;
};
