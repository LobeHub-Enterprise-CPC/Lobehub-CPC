/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_CLIENT_ID } from '@/libs/oidc-provider/desktopClient';

import { GET, HEAD } from './route';

const mocks = vi.hoisted(() => ({
  authEnv: { ENABLE_OIDC: true },
  getInteractionDetails: vi.fn(),
  getInteractionResult: vi.fn(),
  getSession: vi.fn(),
  tenant: { basePath: '/t/acme', publicUrl: 'https://app.example.com/t/acme' },
}));

vi.mock('debug', () => ({ default: () => vi.fn() }));
vi.mock('@/envs/auth', () => ({ authEnv: mocks.authEnv }));
vi.mock('@/auth', () => ({
  getTenantAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));
vi.mock('@/server/modules/Tenant/callbackUrl', () => {
  const buildTenantPublicUrl = (path: string) =>
    `${mocks.tenant.publicUrl}${path === '/' ? '' : path}`;
  return {
    buildTenantPublicUrl,
    tenantPublicPath: (path: string) => {
      const url = new URL(buildTenantPublicUrl(path));
      return `${url.pathname}${url.search}`;
    },
  };
});
vi.mock('@/server/services/oidc', () => ({
  OIDCService: {
    initialize: vi.fn(async () => ({
      getInteractionDetails: mocks.getInteractionDetails,
      getInteractionResult: mocks.getInteractionResult,
    })),
  },
}));

const SESSION_CREATED_AT_MS = 1_700_000_000_999;

const createRequest = (uid: string, { headers = {}, query = '' } = {}) =>
  new Request(`https://app.example.com/t/acme/oidc/interaction/${uid}/login${query}`, {
    headers,
  }) as unknown as NextRequest;

const call = (uid = 'uid-1', options?: Parameters<typeof createRequest>[1]) =>
  GET(createRequest(uid, options), { params: Promise.resolve({ uid }) });

const details = (overrides: Record<string, unknown> = {}) => ({
  params: { client_id: DESKTOP_CLIENT_ID },
  prompt: { name: 'login', reasons: ['no_session'] },
  uid: 'uid-1',
  ...overrides,
});

const signedIn = (setCookies: string[] = []) =>
  mocks.getSession.mockResolvedValue({
    headers: new Headers(setCookies.map((cookie) => ['set-cookie', cookie])),
    response: { session: { createdAt: new Date(SESSION_CREATED_AT_MS) }, user: { id: 'user-1' } },
  });

const signedOut = (setCookies: string[] = []) =>
  mocks.getSession.mockResolvedValue({
    headers: new Headers(setCookies.map((cookie) => ['set-cookie', cookie])),
    response: null,
  });

const expectGuardedRedirect = (response: Response) => {
  expect(response.status).toBe(303);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
};

describe('GET /oidc/interaction/[uid]/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authEnv.ENABLE_OIDC = true;
    mocks.tenant.basePath = '/t/acme';
    mocks.tenant.publicUrl = 'https://app.example.com/t/acme';
    mocks.getInteractionDetails.mockResolvedValue(details());
    mocks.getInteractionResult.mockResolvedValue('https://app.example.com/t/acme/oidc/auth/uid-1');
    signedIn();
  });

  describe('request guards', () => {
    it('is not served when OIDC is disabled', async () => {
      mocks.authEnv.ENABLE_OIDC = false;

      const response = await call();

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.getInteractionDetails).not.toHaveBeenCalled();
    });

    it('answers HEAD with 405 and no side effect', async () => {
      const response = HEAD();

      expect(response.status).toBe(405);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.getInteractionDetails).not.toHaveBeenCalled();
      expect(mocks.getSession).not.toHaveBeenCalled();
    });

    it.each(['iframe', 'image', 'empty', 'script'])(
      'refuses a %s fetch with 400 before reading anything',
      async (dest) => {
        const response = await call('uid-1', { headers: { 'sec-fetch-dest': dest } });

        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(mocks.getInteractionDetails).not.toHaveBeenCalled();
        expect(mocks.getSession).not.toHaveBeenCalled();
        expect(mocks.getInteractionResult).not.toHaveBeenCalled();
      },
    );

    it.each([{}, { 'sec-fetch-dest': 'document' }])('serves a navigation (%o)', async (headers) => {
      const response = await call('uid-1', { headers });

      expect(response.status).toBe(303);
    });
  });

  describe('the interaction cannot be used', () => {
    it.each([
      ['it cannot be read', () => mocks.getInteractionDetails.mockRejectedValue(new Error('x'))],
      [
        'it is another interaction than the route names',
        () => mocks.getInteractionDetails.mockResolvedValue(details({ uid: 'another' })),
      ],
      [
        'it is not a login prompt',
        () =>
          mocks.getInteractionDetails.mockResolvedValue(details({ prompt: { name: 'consent' } })),
      ],
    ])('hands over to the consent page when %s', async (_name, arrange) => {
      arrange();

      const response = await call('uid-1', { query: '?hl=zh-CN' });

      expectGuardedRedirect(response);
      expect(response.headers.get('location')).toBe('/t/acme/oauth/consent/uid-1?hl=zh-CN');
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it('hands over to the consent page when the session cannot be read, never signing in', async () => {
      mocks.getSession.mockRejectedValue(new Error('database down'));

      const response = await call();

      expectGuardedRedirect(response);
      expect(response.headers.get('location')).toBe('/t/acme/oauth/consent/uid-1');
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it('forwards the cookies already obtained when the session time is unusable', async () => {
      const cookies = ['better-auth.session_token=fresh; Path=/', 'better-auth.other=1; Path=/'];
      mocks.getSession.mockResolvedValue({
        headers: new Headers(cookies.map((cookie) => ['set-cookie', cookie])),
        response: { session: { createdAt: 'not a date' }, user: { id: 'user-1' } },
      });

      const response = await call();

      expectGuardedRedirect(response);
      expect(response.headers.get('location')).toBe('/t/acme/oauth/consent/uid-1');
      expect(response.headers.getSetCookie()).toEqual(cookies);
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });
  });

  describe('without a tenant session', () => {
    it.each([
      {
        basePath: '/t/acme',
        layout: 'a path-based organization',
        publicUrl: 'https://app.example.com/t/acme',
      },
      { basePath: '', layout: 'a custom domain', publicUrl: 'https://chat.example.com' },
    ])('redirects to the sign-in page of $layout and returns here afterwards', async (tenant) => {
      mocks.tenant.basePath = tenant.basePath;
      mocks.tenant.publicUrl = tenant.publicUrl;
      signedOut();

      const response = await call('uid-1', { query: '?hl=zh-CN' });

      expectGuardedRedirect(response);
      const location = new URL(response.headers.get('location')!);
      expect(`${location.origin}${location.pathname}`).toBe(`${tenant.publicUrl}/signin`);
      expect(location.searchParams.get('hl')).toBe('zh-CN');
      expect(location.searchParams.get('callbackUrl')).toBe(
        `${tenant.publicUrl}/oidc/interaction/uid-1/login?hl=zh-CN`,
      );
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it('omits hl when the request carries none', async () => {
      signedOut();

      const location = new URL((await call()).headers.get('location')!);

      expect(location.searchParams.has('hl')).toBe(false);
      expect(location.searchParams.get('callbackUrl')).toBe(
        'https://app.example.com/t/acme/oidc/interaction/uid-1/login',
      );
    });
  });

  describe('with a tenant session', () => {
    it('finishes the login of the desktop app with the session account and whole-second time', async () => {
      const response = await call();

      expectGuardedRedirect(response);
      expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
        login: { accountId: 'user-1', remember: true, ts: 1_700_000_000 },
      });
      expect(Number.isInteger(mocks.getInteractionResult.mock.calls[0][1].login.ts)).toBe(true);
      expect(response.headers.get('location')).toBe('/t/acme/oidc/auth/uid-1');
    });

    it.each([[DESKTOP_CLIENT_ID], ['lobehub-mobile'], ['lobehub-market']])(
      'ends with login_required for %s when the provider asks for more than a session',
      async (clientId) => {
        mocks.getInteractionDetails.mockResolvedValue(
          details({
            params: { client_id: clientId },
            prompt: { name: 'login', reasons: ['no_session', 'max_age'] },
          }),
        );

        const response = await call();

        expectGuardedRedirect(response);
        expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
          error: 'login_required',
          error_description: 'Re-authentication is not supported',
        });
      },
    );

    it.each([[['tenant_session_mismatch']], [['no_session', 'tenant_session_mismatch']]])(
      'finishes the desktop login with the session account when the reasons are %j',
      async (reasons) => {
        mocks.getInteractionDetails.mockResolvedValue(
          details({ prompt: { name: 'login', reasons } }),
        );

        const response = await call();

        expectGuardedRedirect(response);
        expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
          login: { accountId: 'user-1', remember: true, ts: 1_700_000_000 },
        });
      },
    );

    it('ends with login_required when a session mismatch comes with a re-authentication reason', async () => {
      mocks.getInteractionDetails.mockResolvedValue(
        details({ prompt: { name: 'login', reasons: ['tenant_session_mismatch', 'max_age'] } }),
      );

      await call();

      expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
        error: 'login_required',
        error_description: 'Re-authentication is not supported',
      });
    });

    it('leaves the "continue as" card to a non-desktop client on a session mismatch', async () => {
      mocks.getInteractionDetails.mockResolvedValue(
        details({
          params: { client_id: 'lobehub-market' },
          prompt: { name: 'login', reasons: ['tenant_session_mismatch'] },
        }),
      );

      const response = await call();

      expect(response.headers.get('location')).toBe('/t/acme/oauth/consent/uid-1');
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it('requires re-authentication even when a re-login is the only reason', async () => {
      mocks.getInteractionDetails.mockResolvedValue(
        details({ prompt: { name: 'login', reasons: ['login_prompt'] } }),
      );

      await call();

      expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
        error: 'login_required',
        error_description: 'Re-authentication is not supported',
      });
    });

    it.each([['lobehub-mobile'], ['lobehub-market'], ['third-party']])(
      'leaves the "continue as" card to %s',
      async (clientId) => {
        mocks.getInteractionDetails.mockResolvedValue(details({ params: { client_id: clientId } }));

        const response = await call('uid-1', { query: '?hl=en' });

        expectGuardedRedirect(response);
        expect(response.headers.get('location')).toBe('/t/acme/oauth/consent/uid-1?hl=en');
        expect(mocks.getInteractionResult).not.toHaveBeenCalled();
      },
    );

    it('hands over to the consent page when the provider refuses the result', async () => {
      mocks.getInteractionResult.mockRejectedValue(new Error('interaction session not found'));

      const response = await call();

      expectGuardedRedirect(response);
      expect(response.headers.get('location')).toBe('/t/acme/oauth/consent/uid-1');
    });
  });

  describe('session cookies', () => {
    const refreshed = ['better-auth.session_token=fresh; Path=/', 'better-auth.other=1; Path=/'];

    it.each([
      ['to sign-in', () => signedOut(refreshed)],
      ['finishing the desktop login', () => signedIn(refreshed)],
      [
        'to the consent page for another client',
        () => {
          signedIn(refreshed);
          mocks.getInteractionDetails.mockResolvedValue(
            details({ params: { client_id: 'lobehub-mobile' } }),
          );
        },
      ],
      [
        'to the consent page after a refused result',
        () => {
          signedIn(refreshed);
          mocks.getInteractionResult.mockRejectedValue(new Error('x'));
        },
      ],
    ])('are forwarded on the redirect %s', async (_name, arrange) => {
      arrange();

      const response = await call();

      expect(response.headers.getSetCookie()).toEqual(refreshed);
    });
  });
});
