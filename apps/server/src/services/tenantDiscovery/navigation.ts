import type { DesktopFlowStatus } from '@/types/spaServerConfig';

/** Navigation preference only: never use this cookie for tenant admission or authentication. */
export const tenantCookieName = (appUrl: string): string =>
  new URL(appUrl).protocol === 'https:' ? '__Host-lobe-last-tenant' : 'lobe-last-tenant';

/**
 * Organization-relative path of the session entry: where the root page sends a visitor whose
 * remembered organization should be asked for the browser's session. It is reserved (a leading
 * `__` never belongs to an SPA route), canonical without a trailing slash, and every URL built
 * for it uses exactly this form.
 */
export const SESSION_ENTRY_PATH = '/__entry';
export const isSessionEntryPath = (path: string): boolean => path === SESSION_ENTRY_PATH;
/** The one non-canonical spelling the framework may hand over; it is only ever redirected. */
export const isNonCanonicalSessionEntryPath = (path: string): boolean =>
  path === `${SESSION_ENTRY_PATH}/`;

/**
 * A copy of `headers` without the cookie-cache namespace of one auth instance: `sessionDataName`
 * (read from that instance's own cookie configuration, never guessed) and everything named
 * `<name>.<any suffix>` (the numbered chunks `<name>.<n>`, but the match does not require digits),
 * each also in its `__Secure-` spelling. The namespace is bounded by that instance's full cookie
 * name, so another tenant's prefix or a longer name such as `<name>X` is never touched. Better Auth
 * decodes this cookie before it decides whether to use it, so a damaged one fails even a lookup
 * that bypasses the cache; the session entry hides it and leaves the session token and every other
 * cookie byte for byte.
 * `removed` lists the hidden names exactly as the browser sent them: Better Auth can no longer
 * see them to clean them up, so {@link expiredCookieHeaders} does.
 */
export const hideSessionDataCookies = (
  headers: Headers,
  sessionDataName: string,
): { headers: Headers; removed: string[] } => {
  const result = new Headers(headers);
  const cookie = headers.get('cookie');
  if (cookie === null) return { headers: result, removed: [] };
  const base = sessionDataName.replace(/^__Secure-/, '');
  const hidden = [base, `__Secure-${base}`];
  const kept: string[] = [];
  const removed: string[] = [];
  for (const raw of cookie.split(';')) {
    const pair = raw.trim();
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const name = equals > 0 ? pair.slice(0, equals) : pair;
    if (hidden.some((candidate) => name === candidate || name.startsWith(`${candidate}.`)))
      removed.push(name);
    else kept.push(pair);
  }
  if (kept.length) result.set('cookie', kept.join('; '));
  else result.delete('cookie');
  return { headers: result, removed };
};

export interface CookieAttributes {
  domain?: string;
  httpOnly?: boolean;
  path?: string;
  sameSite?: string;
  secure?: boolean;
}

/**
 * Expiring `Set-Cookie` lines for `names`, with the auth instance's own cookie attributes. A browser
 * replaces a cookie by name, domain and path, so Path and Domain must equal the original's. The
 * other attributes are kept so the line satisfies the same constraints and matches the original:
 * a `__Secure-` name needs `Secure`, and HttpOnly / SameSite stay as configured. A name that
 * `present` (the `Set-Cookie` lines already on the response) sets or deletes is left to that line,
 * so nothing Better Auth decided is overridden.
 */
export const expiredCookieHeaders = (
  names: string[],
  present: string[],
  attributes: CookieAttributes,
): string[] => {
  const answered = new Set(present.map((line) => line.slice(0, line.indexOf('=')).trim()));
  const lines: string[] = [];
  for (const name of new Set(names)) {
    if (answered.has(name)) continue;
    const parts = [`${name}=`, 'Max-Age=0'];
    if (attributes.path) parts.push(`Path=${attributes.path}`);
    if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
    if (attributes.httpOnly) parts.push('HttpOnly');
    if (attributes.secure || name.startsWith('__Secure-')) parts.push('Secure');
    if (attributes.sameSite)
      parts.push(
        `SameSite=${attributes.sameSite.charAt(0).toUpperCase()}${attributes.sameSite.slice(1).toLowerCase()}`,
      );
    lines.push(parts.join('; '));
  }
  return lines;
};

/** The part of a Better Auth instance the session entry uses. */
interface EntryAuth {
  $context: Promise<{
    authCookies: { sessionData: { attributes: CookieAttributes; name: string } };
  }>;
  api: {
    getSession: (input: {
      headers: Headers;
      query: { disableCookieCache: true; disableRefresh: true };
      returnHeaders: true;
    }) => Promise<{ headers: Headers; response: { user?: unknown } | null }>;
  };
}

/**
 * The session entry's lookup: the persisted session only (no cookie cache, no refresh), with this
 * instance's cache cookie hidden from Better Auth (see {@link hideSessionDataCookies}). Returns
 * whether a session exists and every `Set-Cookie` line for the response: Better Auth's own, then
 * an expiry for each hidden cache cookie it did not answer itself (valid session or not, so a
 * damaged cache does not stay in the browser). Throws when the lookup fails; callers must not
 * read that as "no session".
 */
export const lookupEntrySession = async (
  auth: EntryAuth,
  headers: Headers,
): Promise<{ hasSession: boolean; setCookies: string[] }> => {
  const { authCookies } = await auth.$context;
  const hidden = hideSessionDataCookies(headers, authCookies.sessionData.name);
  const { headers: authHeaders, response } = await auth.api.getSession({
    headers: hidden.headers,
    query: { disableCookieCache: true, disableRefresh: true },
    returnHeaders: true,
  });
  const own = authHeaders.getSetCookie();
  return {
    hasSession: !!response?.user,
    setCookies: [
      ...own,
      ...expiredCookieHeaders(hidden.removed, own, authCookies.sessionData.attributes),
    ],
  };
};

/** Same grammar as the control-plane tenant identifier contract. */
export const isValidTenantId = (value: string): boolean => /^[\w.:-]{1,128}$/.test(value);

const cookie = (value: string, appUrl: string, maxAge: number) =>
  `${tenantCookieName(appUrl)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(appUrl).protocol === 'https:' ? '; Secure' : ''}`;

export const serializeTenantCookie = (tenantId: string, appUrl: string): string => {
  if (!isValidTenantId(tenantId)) throw new Error('INVALID_TENANT_ID');
  return cookie(tenantId, appUrl, 60 * 60 * 24 * 180);
};

export const clearTenantCookie = (appUrl: string): string => cookie('', appUrl, 0);

/**
 * Read and write share this strict browser-document gate; missing Fetch Metadata is not navigation.
 *
 * The gate is Fetch Metadata plus the standard prefetch purpose headers. It deliberately does not
 * test `RSC` / `Next-Router-Prefetch`: Next's proxy adapter removes the flight headers (and the
 * `_rsc` query parameter) before the proxy runs, so those checks could never fire there. Next's
 * RSC fetches and Link prefetches are excluded because they are `cors` / `empty` requests.
 */
export const isDocumentNavigation = (request: Pick<Request, 'method' | 'headers'>): boolean => {
  const { headers } = request;
  return (
    request.method === 'GET' &&
    headers.get('sec-fetch-mode') === 'navigate' &&
    headers.get('sec-fetch-dest') === 'document' &&
    !['purpose', 'sec-purpose'].some((name) =>
      /(?:^|[\s,;])prefetch(?:$|[\s,;])/i.test(headers.get(name) ?? ''),
    )
  );
};

/** Presentation only. The proxy clears client copies; selection independently validates every flow. */
export const DESKTOP_FLOW_HEADER = 'x-lobe-desktop-flow';
export const readDesktopFlowStatus = (value: string | null): DesktopFlowStatus | undefined => {
  switch (value) {
    case 'ready':
    case 'invalid':
    case 'expired':
    case 'unavailable': {
      return value;
    }
  }
};

/** Presentation only. The proxy clears client copies; account selection independently validates. */
export const ROOT_ACCOUNT_HEADER = 'x-lobe-root-account';
export const readRootAccountFlag = (value: string | null): boolean => value === '1';

/** Keep URL logging safe even when sign-in embeds an entire OIDC request in callbackUrl. */
export const redactUrlEmail = (value: string): string => {
  // Server-relative inputs (`/oidc/token?code=...`) are redacted by the same rules and stay relative.
  const relative = value.startsWith('/') && !value.startsWith('//');
  const url = new URL(value, relative ? 'http://relative.invalid' : undefined);
  if (/\/(?:oidc\/(?:auth|authorize)|oauth\/authorize)(?:\/|$)/.test(url.pathname))
    return '[authorization-url-redacted]';
  // Interaction ids are bearer-adjacent: together with the browser's cookie they resume a login.
  url.pathname = url.pathname.replace(
    /(\/(?:oauth\/consent|oidc\/interaction)\/)[^/]+/,
    '$1[redacted]',
  );
  const handoff = /\/oidc\/handoff(?:\/|$)/.test(url.pathname);
  const privateFields =
    /^(?:email|state|code|code_challenge|code_verifier|client_secret|client_assertion|login_hint|nonce|user_code|device_code|access_token|refresh_token|id_token|id_token_hint|token|callbackurl|redirect_uri|returnto|returnurl|url|authorizeurl|authorizationurl)$/i;
  // Iterate a stable key set: replacing duplicated query fields mutates URLSearchParams.
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (
      privateFields.test(key) ||
      (handoff && key.toLowerCase() === 'id') ||
      values.some((entry) => /^(?:https?:\/\/|\/)/i.test(entry))
    )
      url.searchParams.set(key, '[redacted]');
  }
  url.hash = '';
  return relative ? `${url.pathname}${url.search}` : url.toString();
};
