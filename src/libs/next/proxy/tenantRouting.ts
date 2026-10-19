import {
  isBackendPath,
  resolveTenant,
  startsWithSegment,
  stripTenantPath,
  TENANT_PREFIX,
} from '@lobechat/business-tenant/routing';

/**
 * Where a request goes once its tenant is read from the URL (spec A16, A17,
 * FR-RT-04, FR-RT-06). The tenant comes from exactly one place — the
 * `/t/{slug}` prefix today; a Host → tenant mapping can replace this function
 * later without anything downstream changing.
 */

// apps/server/src/modules/Tenant/hostRouting.ts still imports it from here; drop once it imports
// `@lobechat/business-tenant/routing` directly.
export { isBackendPath };

/** Exact service-authenticated gateway roots, shared with the early Host routing decision. */
export const GATEWAY_ROOT_INTERNAL =
  /^\/api\/internal\/gateway\/(?:admission|authorize|tool-result|finalize-abandoned)\/?$/;

/**
 * The only backend paths served without a tenant: authenticated gateway roots,
 * Console's control plane, deployment-wide schedules (FR-AS-02), discovery and
 * the version probe. New endpoints need a tenant by default (FR-RT-04).
 */
const TENANTLESS_BACKEND = [
  GATEWAY_ROOT_INTERNAL,
  /^\/api\/internal\/control-plane(?:\/|$)/,
  /^\/api\/cron(?:\/|$)/,
  /^\/api\/tenant-discovery(?:\/|$)/,
  /^\/api\/version\/?$/,
];

/** Deployment-level surfaces that never exist under a tenant prefix. */
const ROOT_ONLY_BACKEND = ['/api/internal', '/api/cron', '/api/tenant-discovery'];

export type TenantRoute =
  /** Backend request for a tenant: rewrite to `path` and hand the slug over. */
  | { kind: 'tenant-backend'; path: string; slug: string }
  /** Page request for a tenant: serve the SPA for `path` (the tenant is the basename). */
  | { kind: 'tenant-page'; path: string; slug: string }
  /**
   * Tenantless backend path that is allowed without a tenant. `path` is set
   * only when the request carried a tenant prefix that must be dropped.
   */
  | { kind: 'tenantless-backend'; path?: string }
  /** Page without a tenant: apply the document-navigation discovery policy. */
  | { kind: 'tenant-discovery-page' }
  /** Backend refusal. */
  | { code: 'TENANT_INVALID' | 'TENANT_REQUIRED' | 'NOT_FOUND'; kind: 'reject'; status: number };

export const resolveTenantRoute = (url: URL): TenantRoute => {
  const { pathname } = url;
  const tenantSlug = resolveTenant(url)?.slug ?? null;
  const rest = stripTenantPath(pathname);
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
      : { kind: 'tenant-discovery-page' };
  }

  return resolveTenantlessRoute(pathname);
};

/** What a request for `pathname` gets when it names no tenant at all. */
export const resolveTenantlessRoute = (pathname: string): TenantRoute => {
  if (isBackendPath(pathname)) {
    if (TENANTLESS_BACKEND.some((pattern) => pattern.test(pathname)))
      return { kind: 'tenantless-backend' };
    return { code: 'TENANT_REQUIRED', kind: 'reject', status: 400 };
  }

  return { kind: 'tenant-discovery-page' };
};
