import { appEnv } from './app';

/**
 * The single place absolute URLs are built.
 *
 * Multi-tenancy splits `APP_URL` into three different questions that today are
 * all answered by the same expression, and getting them confused is silent:
 *
 * 1. **A page a person will open** — must carry `/t/{slug}`, or the recipient
 *    lands in the wrong tenant (or, with one tenant per account, on the tenant
 *    picker instead of the thing the link was about).
 * 2. **A surface that has no tenant** — sign-in, the tenant picker itself,
 *    marketing. Prefixing these produces a url that cannot resolve.
 * 3. **A server-to-server callback** — webhooks, workflow callbacks, internal
 *    API calls. These address an API route, not a page; a tenant prefix here
 *    404s, and they must keep preferring `INTERNAL_APP_URL` so they bypass the
 *    CDN/proxy.
 *
 * Before this module every call site wrote `appEnv.APP_URL` (or
 * `INTERNAL_APP_URL || APP_URL`) inline, which means the reader cannot tell
 * which of the three a given site meant — and a blanket tenant prefix over all
 * of them would break category 3. Naming the three makes each site declare its
 * intent, so the tenant-prefix question has a single answer per category rather
 * than 58 independent judgement calls.
 */

const TENANT_PREFIX = 't';

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/** Category 2 — the deployment origin, with no tenant scope. */
export const getAppOriginUrl = (): string => trimTrailingSlash(appEnv.APP_URL);

/**
 * Category 3 — server-to-server. Prefers `INTERNAL_APP_URL` to bypass the
 * CDN/proxy, and is never tenant-prefixed because it addresses an API route.
 */
export const getInternalApiUrl = (): string =>
  trimTrailingSlash(appEnv.INTERNAL_APP_URL || appEnv.APP_URL);

/**
 * Category 1 — the base for any URL a person will open.
 *
 * `null` / `undefined` returns the bare origin rather than throwing: plenty of
 * links (sign-in, verification) genuinely have no tenant, and making callers
 * branch would push the decision back out to the 58 call sites this exists to
 * collapse.
 */
export const getTenantBaseUrl = (tenantSlug?: string | null): string => {
  const origin = getAppOriginUrl();
  return tenantSlug ? `${origin}/${TENANT_PREFIX}/${tenantSlug}` : origin;
};

/**
 * Build an absolute, tenant-scoped URL for a page.
 *
 * @example buildTenantUrl('/agent/123', 'acme') // https://host/t/acme/agent/123
 */
export const buildTenantUrl = (path: string, tenantSlug?: string | null): string => {
  const base = getTenantBaseUrl(tenantSlug);
  if (!path || path === '/') return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};
