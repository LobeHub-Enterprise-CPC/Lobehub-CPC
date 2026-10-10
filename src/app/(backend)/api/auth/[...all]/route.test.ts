// @vitest-environment node
import { APIError } from 'better-auth/api';
import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAuthForRequest } from '@/auth';

import { GET, POST } from './route';

type RouteHandler = (request: Request) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  handler: vi.fn<RouteHandler>(async () => Response.json({ ok: true })),
  providers: [] as Array<Record<string, unknown>>,
}));

vi.mock('@lobechat/database/tenant', () => ({
  requireTenantScope: () => ({ slug: 'acme', tenantId: 'tenant-1' }),
}));

vi.mock('@/auth', () => ({
  getAuthForRequest: vi.fn(async () => ({ handler: mocks.handler })),
  getTenantSsoProviders: async () => mocks.providers,
  tenantAuthBasePath: (slug: string) => `/t/${slug}/api/auth`,
}));

const createPostRequest = (body: string, contentType = 'application/json') =>
  new Request('https://localhost/api/auth/sign-in/email', {
    body,
    headers: { 'Content-Type': contentType },
    method: 'POST',
  }) as NextRequest;

const forwardedPath = () => new URL(mocks.handler.mock.lastCall![0].url).pathname;

describe('/api/auth/[...all] route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handler.mockResolvedValue(Response.json({ ok: true }));
    mocks.providers = [];
  });

  it('returns 400 for malformed JSON auth requests before Better Auth handles them', async () => {
    const response = await POST(
      createPostRequest('{"email":"user@example.com","password":"secret",}'),
    );

    await expect(response.json()).resolves.toEqual({
      code: 'INVALID_JSON',
      message: 'Malformed JSON request body',
    });
    expect(response.status).toBe(400);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('passes valid JSON auth requests through without consuming the original body', async () => {
    mocks.handler.mockImplementationOnce(async (request: Request) =>
      Response.json(await request.json()),
    );

    const response = await POST(
      createPostRequest(JSON.stringify({ email: 'user@example.com', password: 'secret' })),
    );

    await expect(response.json()).resolves.toEqual({
      email: 'user@example.com',
      password: 'secret',
    });
    expect(mocks.handler).toHaveBeenCalledTimes(1);
  });

  it('serves the request from the tenant auth mount', async () => {
    const response = await POST(
      createPostRequest(
        'email=user%40example.com&password=secret',
        'application/x-www-form-urlencoded',
      ),
    );

    expect(response.status).toBe(200);
    expect(forwardedPath()).toBe('/t/acme/api/auth/sign-in/email');
  });

  it('delegates GET requests to the tenant Better Auth', async () => {
    const response = await GET(new Request('https://localhost/api/auth/get-session?x=1'));

    expect(response.status).toBe(200);
    expect(forwardedPath()).toBe('/t/acme/api/auth/get-session');
    expect(new URL(mocks.handler.mock.lastCall![0].url).search).toBe('?x=1');
  });

  it('preserves the auth mount when Next retains the original tenant URL after rewriting', async () => {
    const response = await POST(
      new Request('https://localhost/t/acme/api/auth/sign-in/email', {
        body: JSON.stringify({ email: 'user@example.com', password: 'secret' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }) as NextRequest,
    );
    expect(response.status).toBe(200);
    expect(forwardedPath()).toBe('/t/acme/api/auth/sign-in/email');
  });

  it('recognizes tenant-prefixed provider discovery and generic SSO callbacks', async () => {
    mocks.providers = [{ generic: true, providerId: 'okta', protocol: 'oidc' }];
    const response = await GET(new Request('https://localhost/t/acme/api/auth/providers'));
    expect(await response.json()).toMatchObject({ providers: [{ providerId: 'okta' }] });
    expect(mocks.handler).not.toHaveBeenCalled();

    await GET(new Request('https://localhost/t/acme/api/auth/callback/okta?code=c'));
    expect(forwardedPath()).toBe('/t/acme/api/auth/oauth2/callback/okta');
    expect(new URL(mocks.handler.mock.lastCall![0].url).search).toBe('?code=c');
  });

  it('serves a tenant SSO callback from the generic OAuth callback', async () => {
    mocks.providers = [{ generic: true, providerId: 'okta' }];

    await GET(new Request('https://localhost/api/auth/callback/okta?code=c'));

    expect(forwardedPath()).toBe('/t/acme/api/auth/oauth2/callback/okta');
  });

  it('leaves built-in social callbacks alone', async () => {
    mocks.providers = [{ generic: false, providerId: 'google' }];

    await GET(new Request('https://localhost/api/auth/callback/google?code=c'));

    expect(forwardedPath()).toBe('/t/acme/api/auth/callback/google');
  });

  it('lists enabled providers without their configuration', async () => {
    mocks.providers = [
      {
        clientSecret: 'secret',
        displayName: 'Okta',
        logoUrl: null,
        protocol: 'oidc',
        providerId: 'okta',
      },
    ];

    const response = await GET(new Request('https://localhost/api/auth/providers'));

    await expect(response.json()).resolves.toEqual({
      providers: [{ displayName: 'Okta', logoUrl: null, protocol: 'oidc', providerId: 'okta' }],
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('fails closed without exposing decryption or database errors', async () => {
    vi.mocked(getAuthForRequest).mockRejectedValueOnce(new Error('private-secret database error'));
    const response = await GET(new Request('https://localhost/api/auth/get-session'));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ code: 'SSO_UNAVAILABLE', message: 'SSO_UNAVAILABLE' });
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('redirects a failed callback when Next preserves its tenant URL', async () => {
    mocks.handler.mockResolvedValueOnce(
      Response.json({ code: 'EMAIL_NOT_ALLOWED' }, { status: 403 }),
    );
    const response = await GET(
      new Request('https://localhost/t/acme/api/auth/callback/okta?code=private'),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/t/acme/auth-error?error=EMAIL_NOT_ALLOWED');
  });

  it.each(['oauth2/callback', 'sso/callback', 'callback'])(
    "redirects a denied %s callback to the tenant's error page and preserves cleared cookies",
    async (path) => {
      mocks.handler.mockResolvedValueOnce(
        Response.json(
          { code: 'EMAIL_NOT_ALLOWED', message: 'EMAIL_NOT_ALLOWED' },
          { status: 403, headers: { 'Set-Cookie': 'session=; Max-Age=0; Path=/' } },
        ),
      );
      const response = await GET(
        new Request(`https://localhost/api/auth/${path}/provider?code=private&state=private`),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/t/acme/auth-error?error=EMAIL_NOT_ALLOWED');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    },
  );

  it('redirects callback setup failures without leaking internal details', async () => {
    vi.mocked(getAuthForRequest).mockRejectedValueOnce(new Error('private database error'));
    const response = await GET(new Request('https://localhost/api/auth/sso/callback/provider'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/t/acme/auth-error?error=SSO_UNAVAILABLE');
  });

  it('uses a GET redirect when a SAML POST callback is denied', async () => {
    vi.mocked(getAuthForRequest).mockRejectedValueOnce(
      new APIError('FORBIDDEN', { code: 'SSO_ACCESS_DENIED' }),
    );
    const response = await POST(
      new Request('https://localhost/api/auth/sso/saml2/sp/acs/provider', {
        body: 'SAMLResponse=private',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }) as NextRequest,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/t/acme/auth-error?error=SSO_ACCESS_DENIED');
  });

  it('keeps API sign-in failures as JSON', async () => {
    mocks.handler.mockResolvedValueOnce(
      Response.json({ code: 'EMAIL_NOT_ALLOWED' }, { status: 403 }),
    );
    const response = await POST(createPostRequest('{}'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'EMAIL_NOT_ALLOWED' });
    expect(response.headers.get('location')).toBeNull();
  });

  it('preserves successful callback redirects', async () => {
    const redirect = new Response(null, { headers: { Location: '/t/acme' }, status: 302 });
    mocks.handler.mockResolvedValueOnce(redirect);
    expect(await GET(new Request('https://localhost/api/auth/oauth2/callback/provider'))).toBe(
      redirect,
    );
  });
});
