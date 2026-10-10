import { stripTenantPath } from '@lobechat/business-tenant/routing';

const callbackPath =
  /^\/api\/auth\/(?:callback|oauth2\/callback|sso\/callback|sso\/saml2\/sp\/acs)\/[^/]+\/?$/;

/**
 * Protocol callbacks are browser navigations, including SAML form POSTs.
 * `errorPath` is the error page to land on (a tenant's own, under `/t/{slug}`).
 */
export const redirectCallbackError = async (
  request: Request,
  response: Response,
  errorPath = '/auth-error',
) => {
  if (response.status < 400 || !callbackPath.test(stripTenantPath(new URL(request.url).pathname)))
    return response;

  const body = await response
    .clone()
    .json()
    .catch(() => null);
  const code =
    typeof body?.code === 'string' && /^\w{1,100}$/.test(body.code) ? body.code : 'UNKNOWN';
  const headers = new Headers(response.headers);
  headers.delete('Content-Type');
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  headers.set('Location', `${errorPath}?${new URLSearchParams({ error: code })}`);

  // Keep Set-Cookie (including session revocation), but never forward OAuth codes or state.
  // 303 turns SAML POSTs into a GET for the error page.
  return new Response(null, { status: 303, headers });
};
