import { parseTenantPath, TENANT_PREFIX } from '@lobechat/const/tenantPath';

/**
 * Where a request goes once its tenant is read from the URL (spec A16, A17,
 * FR-RT-04, FR-RT-06). The tenant comes from exactly one place — the
 * `/t/{slug}` prefix today; a Host → tenant mapping can replace this function
 * later without anything downstream changing.
 */

/** Backend surfaces: every one of them needs a tenant unless exempt below. */
const BACKEND_PREFIXES = [
  '/api',
  '/trpc',
  '/webapi',
  '/oidc',
  '/oauth/connector',
  '/f/',
  '/market/',
];

/**
 * The only backend paths served without a tenant: Console's control plane,
 * the deployment-wide schedules (which fan out to every tenant, FR-AS-02) and
 * the version probe. New endpoints need a tenant by default (FR-RT-04).
 */
const TENANTLESS_BACKEND = [
  /^\/api\/internal\/control-plane(?:\/|$)/,
  /^\/api\/cron(?:\/|$)/,
  /^\/api\/version\/?$/,
];

/** Deployment-level surfaces that never exist under a tenant prefix. */
const ROOT_ONLY_BACKEND = ['/api/internal', '/api/cron'];

const startsWithSegment = (pathname: string, prefix: string) =>
  prefix.endsWith('/')
    ? pathname.startsWith(prefix)
    : pathname === prefix || pathname.startsWith(`${prefix}/`);

export const isBackendPath = (pathname: string) =>
  BACKEND_PREFIXES.some((prefix) => startsWithSegment(pathname, prefix));

export type TenantRoute =
  /** Backend request for a tenant: rewrite to `path` and hand the slug over. */
  | { kind: 'tenant-backend'; path: string; slug: string }
  /** Page request for a tenant: serve the SPA for `path` (the tenant is the basename). */
  | { kind: 'tenant-page'; path: string; slug: string }
  /** Tenantless backend path that is allowed without a tenant. */
  | { kind: 'tenantless-backend' }
  /** Page without a tenant: the static "use your organisation's address" page. */
  | { kind: 'tenant-required-page' }
  /** Backend refusal. */
  | { code: 'TENANT_INVALID' | 'TENANT_REQUIRED' | 'NOT_FOUND'; kind: 'reject'; status: number };

export const resolveTenantRoute = (pathname: string): TenantRoute => {
  const { rest, tenantSlug } = parseTenantPath(pathname);
  const malformed = tenantSlug === null && new RegExp(`^/${TENANT_PREFIX}(?:/|$)`).test(pathname);

  if (tenantSlug) {
    if (isBackendPath(rest)) {
      // The control plane (FR-CP-01) and the schedules are root-only:
      // `/t/{slug}/api/internal/**` and `/t/{slug}/api/cron/**` are 404.
      if (ROOT_ONLY_BACKEND.some((prefix) => startsWithSegment(rest, prefix)))
        return { code: 'NOT_FOUND', kind: 'reject', status: 404 };
      return { kind: 'tenant-backend', path: rest, slug: tenantSlug };
    }
    return { kind: 'tenant-page', path: rest, slug: tenantSlug };
  }

  if (malformed) {
    const afterPrefix = pathname.replace(/^\/t\/[^/]*/, '') || '/';
    return isBackendPath(afterPrefix)
      ? { code: 'TENANT_INVALID', kind: 'reject', status: 400 }
      : { kind: 'tenant-required-page' };
  }

  if (isBackendPath(pathname)) {
    if (TENANTLESS_BACKEND.some((pattern) => pattern.test(pathname)))
      return { kind: 'tenantless-backend' };
    return { code: 'TENANT_REQUIRED', kind: 'reject', status: 400 };
  }

  return { kind: 'tenant-required-page' };
};

/** Internal route of the static tenant-required page. */
export const TENANT_REQUIRED_PAGE_PATH = '/tenant-required';
