/**
 * Backend surfaces the request proxy only serves under `/t/{slug}` (spec A16, FR-RT-04). The
 * proxy classifies requests with this table and the browser prefixes its own backend calls with
 * it, so both sides always agree on what is a backend path.
 */
export const BACKEND_PREFIXES = [
  '/api',
  '/trpc',
  '/webapi',
  '/oidc',
  '/oauth/connector',
  '/f',
  '/market',
] as const;

/** `pathname` equals `prefix` or lives below it as a whole path segment (`/apiary` is not `/api`). */
export const startsWithSegment = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export const isBackendPath = (pathname: string) =>
  BACKEND_PREFIXES.some((prefix) => startsWithSegment(pathname, prefix));

export {
  isWellFormedTenantSlug,
  mapTenantAppPath,
  parseTenantPath,
  stripTenantPath,
  TENANT_PREFIX,
  withTenantPath,
} from './path';
export type { TenantPublicEntry } from './publicUrl';
export { buildTenantEntryUrl, tenantAppPath } from './publicUrl';
export {
  isRegistrableSlug,
  isReservedSlug,
  RESERVED_SLUGS,
  WORKSPACE_MIRRORED_FIRST_SEGMENTS,
} from './reservedSlugs';
export type { TenantContext } from './resolve';
export { resolveTenant } from './resolve';
