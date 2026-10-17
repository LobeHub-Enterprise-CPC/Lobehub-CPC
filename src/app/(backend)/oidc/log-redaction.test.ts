/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  capturedLogs,
  expectNoSecretsLogged,
  SENTINELS,
  startLogCapture,
  stopLogCapture,
} from '@/libs/oidc-provider/__tests__/logCapture';

const mocks = vi.hoisted(() => ({
  cleanupExpired: vi.fn(),
  clearCurrentOIDCSession: vi.fn(),
  create: vi.fn(),
  fetchAndConsume: vi.fn(),
  findOrCreateGrants: vi.fn(),
  getConsentClientMetadata: vi.fn(),
  getInteractionDetails: vi.fn(),
  getInteractionResult: vi.fn(),
  getUserAuth: vi.fn(),
  middleware: vi.fn(),
}));

vi.mock('debug', async () => (await import('@/libs/oidc-provider/__tests__/logCapture')).debugMock);

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  after: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => ({ name, value: `value-of-${name}` }),
    getAll: () => [
      { name: '_session', value: 'SENTINEL_COOKIE_c0ffee' },
      { name: '_interaction_SENTINEL_UID_c0ffee', value: 'SENTINEL_COOKIE_c0ffee' },
    ],
    has: () => true,
  })),
}));

vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://app.example.com' } }));
vi.mock('@/envs/auth', () => ({ authEnv: { ENABLE_OIDC: true } }));
vi.mock('@/database/server', () => ({ serverDB: {} }));
vi.mock('@lobechat/database', () => ({ serverDB: {} }));
vi.mock('@lobechat/utils/server', () => ({ getUserAuth: mocks.getUserAuth }));

vi.mock('@/database/models/oauthHandoff', () => ({
  OAuthHandoffModel: class {
    cleanupExpired = mocks.cleanupExpired;
    create = mocks.create;
    fetchAndConsume = mocks.fetchAndConsume;
  },
}));

vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  tenantPublicBaseUrl: () => 'https://app.example.com',
  tenantPublicPath: (path: string) => path,
  withTenantPublicRequestUrl: (request: unknown) => request,
}));
vi.mock('@/server/modules/Tenant/gate', () => ({
  withTenantRequest: (handler: unknown) => handler,
}));

vi.mock('@/libs/oidc-provider/session-cleanup', () => ({
  clearCurrentOIDCSession: mocks.clearCurrentOIDCSession,
}));

vi.mock('@/server/services/oidc/oidcProvider', () => ({
  getOIDCProvider: vi.fn(async () => ({ callback: () => mocks.middleware })),
}));

vi.mock('@/server/services/oidc', () => ({
  OIDCService: {
    initialize: vi.fn(async () => ({
      findOrCreateGrants: mocks.findOrCreateGrants,
      getConsentClientMetadata: mocks.getConsentClientMetadata,
      getInteractionDetails: mocks.getInteractionDetails,
      getInteractionResult: mocks.getInteractionResult,
    })),
  },
}));

const withNextUrl = (request: Request) =>
  Object.assign(request, { nextUrl: new URL(request.url) }) as unknown as NextRequest;

const authorizeParams = `state=${SENTINELS.state}&code_challenge=${SENTINELS.challenge}&code_challenge_method=S256&client_id=lobehub-desktop`;

describe('OIDC logs never carry credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startLogCapture();
    mocks.getUserAuth.mockResolvedValue({ userId: 'user-1' });
  });

  afterEach(() => {
    stopLogCapture();
  });

  it('keeps URLs, headers and bodies of provider responses out of the log', async () => {
    mocks.middleware.mockImplementation((_req, res) => {
      res.setHeader('set-cookie', [`_session=${SENTINELS.cookie}; path=/; httponly`]);
      res.setHeader(
        'location',
        `https://app.example.com/oidc/callback/desktop?code=${SENTINELS.code}&state=${SENTINELS.state}`,
      );
      res.setHeader('authorization', `Bearer ${SENTINELS.token}`);
      res.statusCode = 302;
      res.end(JSON.stringify({ access_token: SENTINELS.token }));
    });
    const { GET, POST } = await import('./[...oidc]/route');

    const authorize = await GET(
      new Request(`https://app.example.com/oidc/auth?${authorizeParams}`) as unknown as NextRequest,
    );
    const token = await POST(
      new Request('https://app.example.com/oidc/token?code=' + SENTINELS.code, {
        body: `grant_type=authorization_code&code=${SENTINELS.code}&code_verifier=${SENTINELS.challenge}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }) as unknown as NextRequest,
    );

    // The response itself is untouched; only the diagnostics changed.
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get('location')).toContain(SENTINELS.code);
    expect(await token.text()).toContain(SENTINELS.token);

    expect(capturedLogs()).not.toBe('');
    expectNoSecretsLogged();
  });

  it('keeps the error text of a failing provider out of console.error', async () => {
    mocks.middleware.mockImplementation((_req, _res, next) => {
      next(new Error(`failed query: params ${SENTINELS.state} ${SENTINELS.code}`));
    });
    const { GET } = await import('./[...oidc]/route');

    const response = await GET(
      new Request(`https://app.example.com/oidc/auth?${authorizeParams}`) as unknown as NextRequest,
    );

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
    expectNoSecretsLogged();
  });

  it('keeps cookie values and interaction ids of the interaction context out of the log', async () => {
    const { createContextForInteractionDetails } =
      await import('@/libs/oidc-provider/http-adapter');

    await createContextForInteractionDetails(SENTINELS.uid);

    expect(capturedLogs()).not.toBe('');
    expectNoSecretsLogged();
  });

  describe('GET /oidc/callback/desktop', () => {
    const query = `?code=${SENTINELS.code}&state=${SENTINELS.handoff}`;

    it('does not log the handoff id, code or redirect target', async () => {
      mocks.create.mockResolvedValue(undefined);
      mocks.cleanupExpired.mockResolvedValue(1);
      const { GET } = await import('./callback/desktop/route');

      const response = await GET(
        withNextUrl(new Request(`https://app.example.com/oidc/callback/desktop${query}`)),
      );

      expect(response.status).toBe(307);
      expectNoSecretsLogged();
    });

    it('does not log the failure that carries the stored values', async () => {
      mocks.create.mockRejectedValue(
        new Error(`insert failed, params: ${SENTINELS.handoff}, ${SENTINELS.code}`),
      );
      const { GET } = await import('./callback/desktop/route');

      await GET(withNextUrl(new Request(`https://app.example.com/oidc/callback/desktop${query}`)));

      expectNoSecretsLogged();
    });
  });

  describe('GET /oidc/handoff', () => {
    const request = () =>
      withNextUrl(
        new Request(`https://app.example.com/oidc/handoff?id=${SENTINELS.handoff}&client=desktop`),
      );

    it.each([
      ['found', () => mocks.fetchAndConsume.mockResolvedValue({ code: SENTINELS.code })],
      ['missing', () => mocks.fetchAndConsume.mockResolvedValue(null)],
      [
        'failing',
        () => mocks.fetchAndConsume.mockRejectedValue(new Error(`query ${SENTINELS.handoff}`)),
      ],
    ])('does not log the handoff id when the record is %s', async (_name, arrange) => {
      arrange();
      const { GET } = await import('./handoff/route');

      await GET(request());

      expectNoSecretsLogged();
    });
  });

  describe('POST /oidc/consent', () => {
    const post = async () => {
      const body = new FormData();
      body.set('consent', 'accept');
      body.set('uid', SENTINELS.uid);
      const { POST } = await import('./consent/route');
      return POST(
        new Request('https://app.example.com/oidc/consent', {
          body,
          method: 'POST',
        }) as unknown as NextRequest,
      );
    };

    beforeEach(() => {
      mocks.getInteractionResult.mockResolvedValue(
        `https://app.example.com/oidc/auth/${SENTINELS.uid}?resume=${SENTINELS.resume}&state=${SENTINELS.state}`,
      );
    });

    it('does not log interaction params, results or the resume redirect after login', async () => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: {
          client_id: 'lobehub-desktop',
          code_challenge: SENTINELS.challenge,
          state: SENTINELS.state,
        },
        prompt: { details: {}, name: 'login' },
      });

      const response = await post();

      expect(response.status).toBe(303);
      expectNoSecretsLogged();
    });

    it('does not log the grant id after consent', async () => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: {
          client_id: 'lobehub-desktop',
          code_challenge: SENTINELS.challenge,
          state: SENTINELS.state,
        },
        prompt: { details: { missingOIDCScope: ['openid'] }, name: 'consent' },
      });
      mocks.findOrCreateGrants.mockResolvedValue({
        addOIDCClaims: vi.fn(),
        addOIDCScope: vi.fn(),
        addResourceScope: vi.fn(),
        save: vi.fn(async () => SENTINELS.grant),
      });

      const response = await post();

      expect(response.status).toBe(303);
      expectNoSecretsLogged();
    });

    it('does not log the failure of an unknown interaction', async () => {
      mocks.getInteractionDetails.mockRejectedValue(
        new Error(`interaction session not found ${SENTINELS.uid}`),
      );

      const response = await post();

      expect(response.status).toBe(400);
      expectNoSecretsLogged();
    });

    it('does not log an unexpected failure', async () => {
      mocks.getInteractionDetails.mockRejectedValue(
        new Error(`boom ${SENTINELS.uid} ${SENTINELS.state}`),
      );

      const response = await post();

      expect(response.status).toBe(500);
      expectNoSecretsLogged();
    });
  });

  describe('GET /oidc/interaction/[uid]', () => {
    const get = async () => {
      const { GET } = await import('./interaction/[uid]/route');
      return GET(
        new Request(`https://app.example.com/oidc/interaction/${SENTINELS.uid}`) as NextRequest,
        { params: Promise.resolve({ uid: SENTINELS.uid }) },
      );
    };

    it('does not log the interaction id or authorization params', async () => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: {
          client_id: 'lobehub-desktop',
          code_challenge: SENTINELS.challenge,
          redirect_uri: 'https://app.example.com/oidc/callback/desktop',
          scope: 'openid',
          state: SENTINELS.state,
        },
        prompt: { name: 'consent' },
      });
      mocks.getConsentClientMetadata.mockResolvedValue({});

      const response = await get();

      expect(response.status).toBe(200);
      expectNoSecretsLogged();
    });

    it('does not log an unexpected failure', async () => {
      mocks.getInteractionDetails.mockRejectedValue(new Error(`boom ${SENTINELS.state}`));

      const response = await get();

      expect(response.status).toBe(500);
      expectNoSecretsLogged();
    });
  });

  it('does not log the failure of session cleanup', async () => {
    mocks.clearCurrentOIDCSession.mockRejectedValue(
      new Error(`cleanup ${SENTINELS.cookie} ${SENTINELS.uid}`),
    );
    const { POST } = await import('./clear-session/route');

    await POST(new Request('https://app.example.com/oidc/clear-session') as unknown as NextRequest);

    expectNoSecretsLogged();
  });

  it('does not log the failure of a client metadata lookup', async () => {
    mocks.getConsentClientMetadata.mockRejectedValue(new Error(`lookup ${SENTINELS.token}`));
    const { GET } = await import('./client-metadata/[clientId]/route');

    await GET(new Request('https://app.example.com/oidc/client-metadata/c') as NextRequest, {
      params: Promise.resolve({ clientId: 'lobehub-desktop' }),
    });

    expectNoSecretsLogged();
  });
});
