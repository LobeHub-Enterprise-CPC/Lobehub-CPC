import { buildTenantPath } from '@lobechat/const/tenantPath';
import { requireTenantScope } from '@lobechat/database/tenant';
import { APIError } from 'better-auth/api';
import type { NextRequest } from 'next/server';

import { getAuthForRequest, getTenantSsoProviders, tenantAuthBasePath } from '@/auth';
import { redirectCallbackError } from '@/libs/better-auth/callback-error-response';
import { withTenantRequest } from '@/server/modules/Tenant/gate';

const jsonContentTypeRegex = /^application\/(?:[a-z0-9.+-]*\+)?json/i;

const malformedJsonResponse = () =>
  Response.json({ code: 'INVALID_JSON', message: 'Malformed JSON request body' }, { status: 400 });

/**
 * better-call currently treats Request.json() SyntaxError as a server error.
 * Validate JSON bodies at the route boundary so malformed client payloads stay 400s.
 */
const validateJsonBody = async (request: Request) => {
  const contentType = request.headers.get('content-type') || '';
  if (!request.body || !jsonContentTypeRegex.test(contentType)) return;

  try {
    await request.clone().json();
  } catch (error) {
    if (error instanceof SyntaxError) return malformedJsonResponse();
    throw error;
  }
};

const CALLBACK_PATH = /^\/callback\/([^/]+)$/;

/**
 * The proxy rewrote `/t/{slug}/api/auth/...` to `/api/auth/...`; the tenant's
 * better-auth is mounted at `/t/{slug}/api/auth`, so the request goes back to
 * its tenant path. A tenant SSO callback arrives at `/callback/{providerId}`
 * (the URL registered with the identity provider, spec FR-ID-09): built-in
 * providers are served there, generic OAuth ones by `/oauth2/callback/{id}`.
 */
const toTenantAuthRequest = async (request: Request): Promise<Request> => {
  const { slug } = requireTenantScope();
  const url = new URL(request.url);
  let rest = url.pathname.replace(/^\/api\/auth/, '') || '/';

  const callback = CALLBACK_PATH.exec(rest);
  if (callback) {
    const providerId = decodeURIComponent(callback[1]);
    const providers = await getTenantSsoProviders();
    if (providers.some((provider) => provider.generic && provider.providerId === providerId))
      rest = `/oauth2/callback/${encodeURIComponent(providerId)}`;
  }

  url.pathname = `${tenantAuthBasePath(slug)}${rest}`;
  return new Request(url, request);
};

/** Login page data (FR-ID-09): enabled providers, never their configuration or secrets. */
const listProviders = async () => {
  const providers = await getTenantSsoProviders();
  return Response.json(
    {
      providers: providers.map((provider) => ({
        displayName: provider.displayName,
        logoUrl: provider.logoUrl,
        protocol: provider.protocol,
        providerId: provider.providerId,
      })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
};

/**
 * Hands the request to the tenant's better-auth. A failed protocol callback (a
 * browser navigation) lands on the tenant's error page instead of a JSON body.
 */
const dispatch = async (request: Request) => {
  const errorPath = buildTenantPath('/auth-error', requireTenantScope().slug);
  try {
    const auth = await getAuthForRequest(request);
    const response = await auth.handler(await toTenantAuthRequest(request));
    return await redirectCallbackError(request, response, errorPath);
  } catch (error) {
    const status = error instanceof APIError ? error.statusCode : 503;
    const code = error instanceof APIError ? error.body?.code : 'SSO_UNAVAILABLE';
    return redirectCallbackError(
      request,
      Response.json({ code, message: code }, { status, headers: { 'Cache-Control': 'no-store' } }),
      errorPath,
    );
  }
};

const handleGet = async (request: Request) => {
  if (new URL(request.url).pathname === '/api/auth/providers') return listProviders();
  return dispatch(request);
};

const handlePost = async (request: NextRequest) => {
  const invalidJsonResponse = await validateJsonBody(request);
  if (invalidJsonResponse) return invalidJsonResponse;

  return dispatch(request);
};

export const GET = withTenantRequest(handleGet);
export const POST = withTenantRequest(handlePost);
