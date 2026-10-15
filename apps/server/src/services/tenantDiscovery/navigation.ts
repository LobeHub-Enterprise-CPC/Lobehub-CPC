import type { DesktopFlowStatus } from '@/types/spaServerConfig';

/** Navigation preference only: never use this cookie for tenant admission or authentication. */
export const tenantCookieName = (appUrl: string): string =>
  new URL(appUrl).protocol === 'https:' ? '__Host-lobe-last-tenant' : 'lobe-last-tenant';

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
