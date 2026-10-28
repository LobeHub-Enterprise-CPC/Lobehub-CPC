/**
 * Remote server addresses.
 *
 * Shared by the Electron main process, the desktop renderer and the CLI so every
 * consumer joins paths onto a tenant address with the same rules. Pure and
 * dependency free on purpose: it is bundled into all three.
 *
 * The configured remote server URL is a tenant address: `https://host/orgs/{slug}`
 * (default entry) or a custom-domain root such as `https://custom.host`. Every
 * tenant endpoint (/oidc, /trpc, /webapi, /api/auth, /market, ...) lives under
 * that address. `new URL('/oidc/token', remoteUrl)` and `new URL(path, remoteUrl)`
 * resolve a rooted path against the origin and silently drop `/orgs/{slug}`, which
 * the server rejects with TENANT_REQUIRED, so code that talks to a remote server joins
 * paths with the helpers here instead.
 */

const trimSlashes = (pathname: string) => pathname.replaceAll(/\/{2,}/g, '/').replace(/\/+$/, '');

const parseHttpBase = (remoteBase: string | URL): URL => {
  const base = new URL(remoteBase);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError(`Remote server URL must be http(s): ${base.protocol}`);
  }
  return base;
};

/** Base path without trailing slash; `''` for a root base. */
const basePathOf = (base: URL) => trimSlashes(base.pathname);

const underBasePath = (pathname: string, basePath: string) =>
  basePath === '' || pathname === basePath || pathname.startsWith(`${basePath}/`);

/**
 * Whether an app path (or a URL pathname on the same origin) already sits under
 * the base path of the remote address. Compares whole segments, so `/orgs/acme-x`
 * is not under `/orgs/acme`. Every path is under a root base.
 */
export const isUnderRemoteBase = (pathname: string, remoteBase: string | URL): boolean =>
  underBasePath(pathname, basePathOf(parseHttpBase(remoteBase)));

/**
 * Mount an in-app absolute path (query/hash allowed) under the remote address,
 * keeping its path prefix: `('/oidc/token', 'https://host/orgs/acme/')` ->
 * `https://host/orgs/acme/oidc/token`.
 *
 * - A path that already starts with the base path is not prefixed twice.
 * - Only rooted paths (or `''` / `?query`) are accepted. Protocol-relative
 *   (`//evil`), backslash and absolute URLs throw, so a caller can never be
 *   steered to another origin.
 * - Dot segments that would climb out of the base path (`/../orgs/other`) throw, so
 *   a path can never address another tenant.
 */
export const buildRemoteUrl = (path: string, remoteBase: string | URL): URL => {
  const base = parseHttpBase(remoteBase);
  const basePath = basePathOf(base);

  if (path !== '' && !path.startsWith('/') && !path.startsWith('?')) {
    throw new TypeError(`Remote path must be an application path starting with "/": ${path}`);
  }
  if (path.startsWith('//') || path.includes('\\')) {
    throw new TypeError(`Remote path must not be protocol-relative: ${path}`);
  }

  const suffixStart = path.search(/[#?]/);
  const pathname = suffixStart === -1 ? path : path.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? '' : path.slice(suffixStart);

  const mounted = underBasePath(pathname, basePath) ? pathname : `${basePath}${pathname}`;
  const url = new URL(`${base.origin}${mounted}${suffix}`);

  if (url.origin !== base.origin || !underBasePath(url.pathname, basePath)) {
    throw new TypeError(`Remote path escapes the remote server address: ${path}`);
  }

  return url;
};

/**
 * Canonical form of a user-entered remote server address: trimmed, lowercase
 * origin, path prefix kept, duplicate and trailing slashes, query and hash
 * dropped (`https://host/orgs/acme/` -> `https://host/orgs/acme`, `https://host/` ->
 * `https://host`). Empty and unparsable / non-http(s) input is returned as is
 * (trimmed) for the existing validators to reject.
 */
export function normalizeRemoteBaseUrl(raw: string): string;
export function normalizeRemoteBaseUrl(raw: string | undefined): string | undefined;
export function normalizeRemoteBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  try {
    const base = parseHttpBase(trimmed);
    return `${base.origin}${basePathOf(base)}`;
  } catch {
    return trimmed;
  }
}

/**
 * The app path of `pathname` below the base path of the remote address
 * (`('/orgs/acme/f/x', 'https://host/orgs/acme')` -> `/f/x`, the base itself -> `/`),
 * or `null` when the pathname is outside it: another tenant, a sibling slug
 * (`/orgs/acme-x`), or a path the server did not prefix. Every path is below a root
 * base and is returned unchanged.
 */
export const relativeToRemoteBase = (pathname: string, remoteBase: string | URL): string | null => {
  const basePath = basePathOf(parseHttpBase(remoteBase));
  if (!underBasePath(pathname, basePath)) return null;

  const rest = pathname.slice(basePath.length);
  return rest === '' ? '/' : rest;
};

/**
 * Resolve a reference the server handed to a renderer-side caller (avatar, file
 * or asset URL) so it can be loaded or opened outside the remote origin.
 *
 * - A server-relative path (`/webapi/user/avatar/...`, `/f/...`) is mounted under
 *   the remote address, keeping its tenant prefix; a path the server already
 *   prefixed is not prefixed twice.
 * - Everything else is returned as is: absolute http(s) URLs, `data:` / `blob:`,
 *   protocol-relative and plain relative values, and the empty string.
 * - Unlike {@link buildRemoteUrl} it never throws: with no usable base (not
 *   configured yet, unparsable, not http(s)) or a path that would leave the
 *   base, the value is returned unchanged, so a bad value can never turn into a
 *   link to another tenant or origin.
 */
export const resolveRemoteUrl = (value: string, remoteBase: string | URL | undefined): string => {
  if (!remoteBase || !value.startsWith('/') || value.startsWith('//')) return value;

  try {
    return buildRemoteUrl(value, remoteBase).toString();
  } catch {
    return value;
  }
};
