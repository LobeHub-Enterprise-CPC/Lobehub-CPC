import { parseTenantPath } from './tenantPath';

/**
 * Resolving which tenant a backend request addresses.
 *
 * `/api`, `/trpc` and `/webapi` deliberately do not go through the proxy
 * middleware (see `src/proxy.ts`), so none of them inherit the SPA's router
 * basename — each has to read the tenant segment from the request itself. This
 * module is that reading, shared so the three cannot drift apart.
 */

export type TenantResolutionFailure = 'conflict' | 'malformed' | 'missing';

export type TenantResolution =
  { ok: false; reason: TenantResolutionFailure } | { ok: true; tenantSlug: string };

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
 * **A business request without a tenant path is refused.** A token that names
 * a tenant does not stand in for the path (spec A7, FR-RT-04): the RFC requires
 * every business API call to name its tenant in the URL, so CLI and API-key
 * clients call `/t/{slug}/...` like the browser does. Callers handle the
 * tenant-less surfaces (auth, control plane, health, tenant list) BEFORE
 * calling this, from one exemption list.
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

  if (tenantSlug === null) return { ok: false, reason: 'missing' };

  return { ok: true, tenantSlug };
};

/** Human-readable reason, safe to return to the caller (names no internals). */
const FAILURE_DESCRIPTIONS: Record<TenantResolutionFailure, string> = {
  conflict: 'Tenant in the request path does not match the tenant in the credential.',
  malformed: 'Malformed tenant segment in the request path.',
  missing: 'The request path does not name a tenant.',
};

export const describeTenantResolutionFailure = (reason: TenantResolutionFailure): string =>
  FAILURE_DESCRIPTIONS[reason];

/** Stable error codes returned to the caller (FR-RT-04). */
export const TENANT_RESOLUTION_ERROR_CODES: Record<TenantResolutionFailure, string> = {
  conflict: 'TENANT_MISMATCH',
  malformed: 'TENANT_INVALID',
  missing: 'TENANT_REQUIRED',
};
