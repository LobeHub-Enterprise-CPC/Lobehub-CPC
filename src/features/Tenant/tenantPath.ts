/**
 * The literal first segment that marks a tenant-scoped url: `/t/{slug}/...`.
 *
 * The tenant lives in the URL rather than the session on purpose: a session-held
 * "current tenant" makes two browser tabs on two tenants impossible, and the bug
 * it produces is silent — the second tab quietly acts on the first tab's tenant.
 */
export const TENANT_PREFIX = 't';

/**
 * Slug syntax only. Whether a syntactically valid slug is *allowed* to be
 * registered is a separate question — see `reservedSlugs.ts`, which cannot be
 * imported here without a cycle (it needs the workspace segment list, and
 * `workspaceAwarePath` needs this module).
 *
 * Parsing deliberately does not consult the reserved list: `/t/agent` is
 * unambiguous precisely because the `/t/` prefix is explicit, so a tenant named
 * `agent` shadows nothing once it is prefixed. The reserved list exists to stop
 * such a slug being registered, since the same name at the root WOULD shadow.
 */
const SLUG_REGEX = /^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/;

export const isWellFormedTenantSlug = (slug: string): boolean => SLUG_REGEX.test(slug);

export interface ParsedTenantPath {
  /** The path with the `/t/{slug}` prefix removed; always starts with `/`. */
  rest: string;
  /** `null` when the path carries no tenant prefix. */
  tenantSlug: string | null;
}

const TENANT_PATH_REGEX = new RegExp(`^/${TENANT_PREFIX}/([^/?#]+)(?=[/?#]|$)`);

/**
 * Split `/t/{slug}/rest` into its tenant and the rest.
 *
 * A malformed slug is reported as `tenantSlug: null` with `rest` left whole, so
 * the url falls through to normal routing and 404s visibly instead of being
 * treated as a tenant that does not exist.
 */
export const parseTenantPath = (pathname: string): ParsedTenantPath => {
  const match = TENANT_PATH_REGEX.exec(pathname);
  if (!match) return { rest: pathname, tenantSlug: null };

  if (!isWellFormedTenantSlug(match[1])) return { rest: pathname, tenantSlug: null };

  const rest = pathname.slice(match[0].length);
  return { rest: rest === '' ? '/' : rest, tenantSlug: match[1] };
};

/**
 * Prefix an absolute path with `/t/{slug}`, idempotently.
 *
 * Returns `to` unchanged for a relative path (react-router resolves those
 * itself) and when the path already carries this tenant's prefix.
 */
export const buildTenantPath = (to: string, tenantSlug: string | null | undefined): string => {
  if (!tenantSlug) return to;
  if (!to.startsWith('/')) return to;

  const { tenantSlug: existing } = parseTenantPath(to);
  if (existing === tenantSlug) return to;

  const base = `/${TENANT_PREFIX}/${tenantSlug}`;
  return to === '/' ? base : `${base}${to}`;
};

/** Strip any `/t/{slug}` prefix. Inverse of {@link buildTenantPath}. */
export const stripTenantPath = (to: string): string => parseTenantPath(to).rest;
