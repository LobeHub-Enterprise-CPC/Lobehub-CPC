import { parseTenantPath } from './tenantPath';

/**
 * Resolving which tenant a backend request addresses.
 *
 * `/api`, `/trpc` and `/webapi` deliberately do not go through the proxy
 * middleware (see `src/proxy.ts`), so none of them inherit the SPA's router
 * basename — each has to read the tenant segment from the request itself. This
 * module is that reading, shared so the three cannot drift apart.
 */

export type TenantResolution =
  { reason: 'conflict' | 'malformed'; ok: false } | { ok: true; tenantSlug: string | null };

export interface TenantRequestInput {
  /** Path of the incoming request, e.g. `/t/acme/trpc/lambda/foo`. */
  pathname: string;
  /**
   * Tenant claim carried by the caller's credential, when the token format has
   * one. `undefined` means the token says nothing about a tenant.
   */
  tokenTenantSlug?: string | null;
}

/**
 * Resolve the tenant for a backend request.
 *
 * Two rules, both deliberate:
 *
 * **The URL wins over any header.** This function never accepts a tenant from a
 * header, which is why one is not a parameter. A header-supplied tenant would be
 * an attacker-controlled input that silently overrides the path the user
 * actually visited, and the resulting cross-tenant read would look like a
 * perfectly ordinary authorized request in every log.
 *
 * **A token/URL disagreement is refused, not resolved.** When the credential
 * names one tenant and the path names another, there is no safe way to pick:
 * preferring the token ignores what the user asked for, preferring the URL lets
 * a token minted for tenant A act on tenant B. Both readings are a cross-tenant
 * operation that completes successfully. The only correct response is to fail
 * the request — so callers get `ok: false` and must reject, not choose.
 */
export const resolveRequestTenant = ({
  pathname,
  tokenTenantSlug,
}: TenantRequestInput): TenantResolution => {
  const { tenantSlug } = parseTenantPath(pathname);

  // A `/t/...` path whose slug did not parse is malformed rather than
  // tenant-less: treating it as "no tenant" would silently downgrade a scoped
  // request to an unscoped one.
  if (tenantSlug === null && /^\/t(?:\/|$)/.test(pathname)) {
    return { ok: false, reason: 'malformed' };
  }

  if (tokenTenantSlug && tenantSlug && tokenTenantSlug !== tenantSlug) {
    return { ok: false, reason: 'conflict' };
  }

  // A token that names a tenant on an unscoped path still scopes the request —
  // that is how a non-browser client (CLI, API key) addresses a tenant without
  // a URL prefix.
  return { ok: true, tenantSlug: tenantSlug ?? tokenTenantSlug ?? null };
};

/** Human-readable reason, safe to return to the caller (names no internals). */
export const describeTenantResolutionFailure = (reason: 'conflict' | 'malformed'): string =>
  reason === 'conflict'
    ? 'Tenant in the request path does not match the tenant in the credential.'
    : 'Malformed tenant segment in the request path.';
