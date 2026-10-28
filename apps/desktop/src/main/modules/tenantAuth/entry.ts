import { normalizeRemoteBaseUrl } from '@lobechat/utils/remoteUrl';
import { parseTenantPath, withTenantPath } from '@lobechat/utils/tenantPath';

/** Hosts for which plain http is accepted, development builds only. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

export type EntryKind =
  /** Bare platform origin: needs the organization lookup page. */
  | 'platform'
  /** A tenant address (custom domain, `/orgs/{slug}`, or a standalone server): direct OIDC. */
  | 'tenant'
  /** Cannot be an organization address. */
  | 'invalid';

export const isSecureOrLoopbackUrl = (url: URL, allowLoopbackHttp: boolean): boolean => {
  if (url.protocol === 'https:') return true;
  return allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
};

/**
 * Canonical, credential-free https entry (`https://host[/orgs/slug]`), or `null` when the
 * input is not an acceptable address to ever send credentials to. A legacy `/t/slug` entry is
 * respelled, so a login stored under it no longer validates and is made again.
 */
export const normalizeEntryUrl = (raw: string, allowLoopbackHttp = false): string | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (!isSecureOrLoopbackUrl(url, allowLoopbackHttp)) return null;
  if (url.username || url.password) return null;

  const normalized = normalizeRemoteBaseUrl(url.toString());
  if (!normalized) return null;

  const base = new URL(normalized);
  const { tenantSlug } = parseTenantPath(base.pathname);
  return tenantSlug ? `${base.origin}${withTenantPath(base.pathname, tenantSlug)}` : normalized;
};

export const buildExpectedIssuer = (entryUrl: string): string => `${entryUrl}/oidc`;

/**
 * Decide whether a user-supplied address already names a tenant entry.
 *
 * - On the platform host only `/orgs/{slug}` is an entry; the bare origin is the platform.
 * - On any other host the address is the user's chosen server (custom domain or a
 *   standalone deployment) and is tried directly; the preflight decides if it is real.
 *
 * The slug syntax comes from the same parser the server routes with.
 */
export const classifyEntry = (
  entryUrl: string,
  platformOrigin: string,
): { kind: EntryKind; slug?: string } => {
  const entry = new URL(entryUrl);
  const platform = new URL(platformOrigin);
  const pathname = entry.pathname.replace(/\/+$/, '');

  if (entry.host.toLowerCase() !== platform.host.toLowerCase()) {
    const { rest, tenantSlug } = parseTenantPath(pathname || '/');
    return { kind: 'tenant', slug: tenantSlug && rest === '/' ? tenantSlug : undefined };
  }

  if (pathname === '') return { kind: 'platform' };

  const { rest, tenantSlug } = parseTenantPath(pathname);
  if (tenantSlug && rest === '/') return { kind: 'tenant', slug: tenantSlug };

  return { kind: 'invalid' };
};

export const isSameHost = (entryUrl: string, platformOrigin: string): boolean => {
  try {
    return new URL(entryUrl).host.toLowerCase() === new URL(platformOrigin).host.toLowerCase();
  } catch {
    return false;
  }
};
