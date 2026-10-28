/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { errors } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const mocks = vi.hoisted(() => ({
  findOrCreateGrants: vi.fn(),
  getInteractionDetails: vi.fn(),
  getInteractionResult: vi.fn(),
  getSession: vi.fn(),
  resolveReviewAccess: vi.fn(),
}));

const SESSION_CREATED_AT_MS = 1_700_000_000_999;

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));

vi.mock('@/server/services/acceptanceReview/access', () => ({
  resolveReviewAccess: mocks.resolveReviewAccess,
}));

vi.mock('debug', () => ({ default: () => vi.fn() }));

vi.mock('@/auth', () => ({
  getTenantAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));

// The organization is served from its own origin; the form must be submitted from there.
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantPublicUrl: (path: string) => `https://lobehub.com/t/acme${path}`,
}));

vi.mock('@/server/services/oidc', () => ({
  OIDCService: {
    initialize: vi.fn(async () => ({
      findOrCreateGrants: mocks.findOrCreateGrants,
      getInteractionDetails: mocks.getInteractionDetails,
      getInteractionResult: mocks.getInteractionResult,
    })),
  },
}));

const createRequest = (
  fields: Record<string, string>,
  headers: Record<string, string> = { origin: 'https://lobehub.com' },
) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request('https://lobehub-cloud-next-stable.vercel.app/oidc/consent', {
    body,
    headers,
    method: 'POST',
  }) as unknown as NextRequest;
};

const signedIn = (userId: string, setCookies: string[] = []) =>
  mocks.getSession.mockResolvedValue({
    headers: new Headers(setCookies.map((cookie) => ['set-cookie', cookie])),
    response: { session: { createdAt: new Date(SESSION_CREATED_AT_MS) }, user: { id: userId } },
  });

describe('POST /oidc/consent', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    signedIn('user-1');
    mocks.getInteractionDetails.mockResolvedValue({
      params: { client_id: 'lobehub-desktop' },
      prompt: { details: {}, name: 'login', reasons: ['no_session'] },
      uid: 'uid-1',
    });
    mocks.getInteractionResult.mockResolvedValue(
      'https://app.lobehub.com/oidc/auth/uid-1?resume=1',
    );
  });

  it('redirects back into the provider on the origin the browser is using', async () => {
    const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/oidc/auth/uid-1?resume=1');
    expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
      login: { accountId: 'user-1', remember: true, ts: 1_700_000_000 },
    });
  });

  it('forwards the cookies Better Auth set while reading the session', async () => {
    signedIn('user-1', ['better-auth.session_token=fresh; Path=/']);

    const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

    expect(response.headers.getSetCookie()).toEqual(['better-auth.session_token=fresh; Path=/']);
  });

  describe('failures keep the session cookies', () => {
    const cookies = ['better-auth.session_token=fresh; Path=/', 'better-auth.other=1; Path=/'];

    it('puts every cookie on the 500 when the provider refuses the login result', async () => {
      signedIn('user-1', cookies);
      mocks.getInteractionResult.mockRejectedValue(new Error('x'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual(cookies);
    });

    it('puts every cookie on the 500 when the Grant helper fails', async () => {
      signedIn('user-1', cookies);
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-desktop' },
        prompt: { details: {}, name: 'consent' },
        session: { accountId: 'user-1' },
        uid: 'uid-1',
      });
      mocks.findOrCreateGrants.mockRejectedValue(new Error('x'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual(cookies);
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it('puts every cookie on the 500 when ending the consent interaction fails', async () => {
      signedIn('user-1', cookies);
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-desktop' },
        prompt: { details: {}, name: 'consent' },
        session: { accountId: 'user-1' },
        uid: 'uid-1',
      });
      mocks.findOrCreateGrants.mockResolvedValue({
        addOIDCClaims: vi.fn(),
        addOIDCScope: vi.fn(),
        addResourceScope: vi.fn(),
        save: vi.fn(async () => 'grant-1'),
      });
      mocks.getInteractionResult.mockRejectedValue(new Error('x'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual(cookies);
    });

    it('puts every cookie on the 500 when the session time is unusable', async () => {
      mocks.getSession.mockResolvedValue({
        headers: new Headers(cookies.map((cookie) => ['set-cookie', cookie])),
        response: { session: { createdAt: 'not a date' }, user: { id: 'user-1' } },
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual(cookies);
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });
  });

  describe('request guards', () => {
    it.each([
      ['missing', {}],
      ['from another site', { origin: 'https://evil.example' }],
      ['from the same host on another scheme', { origin: 'http://lobehub.com' }],
      ['"null" without Sec-Fetch-Site', { origin: 'null' }],
      ['"null" from a same-site request', { 'origin': 'null', 'sec-fetch-site': 'same-site' }],
      [
        'matching but sent cross-site',
        { 'origin': 'https://lobehub.com', 'sec-fetch-site': 'cross-site' },
      ],
      [
        'matching but sent same-site',
        { 'origin': 'https://lobehub.com', 'sec-fetch-site': 'same-site' },
      ],
      [
        'matching but user-initiated',
        { 'origin': 'https://lobehub.com', 'sec-fetch-site': 'none' },
      ],
      [
        'mismatching despite same-origin',
        { 'origin': 'https://evil.example', 'sec-fetch-site': 'same-origin' },
      ],
    ])('refuses a form whose Origin is %s, touching nothing', async (_name, headers) => {
      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }, headers));

      expect(response.status).toBe(403);
      expect(mocks.getInteractionDetails).not.toHaveBeenCalled();
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it.each([
      ['matches alone', { origin: 'https://lobehub.com' }],
      [
        'matches and the request is same-origin',
        { 'origin': 'https://lobehub.com', 'sec-fetch-site': 'same-origin' },
      ],
      // The consent page is served with Referrer-Policy: no-referrer, which makes Origin "null".
      ['is "null" on a same-origin request', { 'origin': 'null', 'sec-fetch-site': 'same-origin' }],
      ['is absent on a same-origin request', { 'sec-fetch-site': 'same-origin' }],
    ])('accepts a form whose Origin %s', async (_name, headers) => {
      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }, headers));

      expect(response.status).toBe(303);
      expect(mocks.getInteractionResult).toHaveBeenCalled();
    });

    it('returns 400 when the interaction behind the cookie is not the one submitted', async () => {
      const response = await POST(createRequest({ consent: 'accept', uid: 'another-uid' }));

      expect(response.status).toBe(400);
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });
  });

  describe('login prompt', () => {
    it('answers 401 without a session and does not end the interaction', async () => {
      mocks.getSession.mockResolvedValue({ headers: new Headers(), response: null });

      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(response.status).toBe(401);
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it.each([[['tenant_session_mismatch']], [['no_session', 'tenant_session_mismatch']]])(
      'finishes the login with the session account when the reasons are %j',
      async (reasons) => {
        mocks.getInteractionDetails.mockResolvedValue({
          params: { client_id: 'lobehub-desktop' },
          prompt: { details: {}, name: 'login', reasons },
          uid: 'uid-1',
        });

        await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

        expect(mocks.getInteractionResult).toHaveBeenCalledWith(
          'uid-1',
          expect.objectContaining({ login: expect.objectContaining({ accountId: 'user-1' }) }),
        );
      },
    );

    it.each([['login_prompt'], ['max_age'], ['id_token_hint']])(
      'ends the interaction with login_required when the provider also asks for %s',
      async (extra) => {
        mocks.getInteractionDetails.mockResolvedValue({
          params: { client_id: 'lobehub-desktop' },
          prompt: { details: {}, name: 'login', reasons: ['no_session', extra] },
          uid: 'uid-1',
        });

        await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

        expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
          error: 'login_required',
          error_description: 'Re-authentication is not supported',
        });
      },
    );
  });

  describe('other prompts', () => {
    it.each([['accept'], ['deny']])(
      'answers 400 unsupported_interaction on %s without reading the session or changing anything',
      async (choice) => {
        mocks.getInteractionDetails.mockResolvedValue({
          params: { client_id: 'lobehub-desktop' },
          prompt: { details: {}, name: 'select_account' },
          session: { accountId: 'user-1' },
          uid: 'uid-1',
        });

        const response = await POST(createRequest({ consent: choice, uid: 'uid-1' }));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ error: 'unsupported_interaction' });
        expect(mocks.getSession).not.toHaveBeenCalled();
        expect(mocks.findOrCreateGrants).not.toHaveBeenCalled();
        expect(mocks.getInteractionResult).not.toHaveBeenCalled();
      },
    );
  });

  describe('consent prompt', () => {
    beforeEach(() => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-desktop' },
        prompt: { details: { missingOIDCScope: ['openid'] }, name: 'consent' },
        session: { accountId: 'user-1' },
        uid: 'uid-1',
      });
      mocks.findOrCreateGrants.mockResolvedValue({
        addOIDCClaims: vi.fn(),
        addOIDCScope: vi.fn(),
        addResourceScope: vi.fn(),
        save: vi.fn(async () => 'grant-1'),
      });
    });

    it('grants the account the provider session holds', async () => {
      await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(mocks.findOrCreateGrants).toHaveBeenCalledWith('user-1', 'lobehub-desktop', undefined);
      expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
        consent: { grantId: 'grant-1' },
      });
    });

    it.each([
      ['the browser now holds another account', () => signedIn('user-2')],
      [
        'the browser holds no session',
        () => mocks.getSession.mockResolvedValue({ headers: new Headers(), response: null }),
      ],
    ])('refuses with session_changed when %s, writing no grant', async (_name, arrange) => {
      arrange();

      const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'session_changed' });
      expect(mocks.findOrCreateGrants).not.toHaveBeenCalled();
      expect(mocks.getInteractionResult).not.toHaveBeenCalled();
    });

    it('lets the user decline without a session check', async () => {
      signedIn('user-2');

      const response = await POST(createRequest({ consent: 'deny', uid: 'uid-1' }));

      expect(response.status).toBe(303);
      expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      });
      expect(mocks.findOrCreateGrants).not.toHaveBeenCalled();
    });
  });

  it('returns 400 when the interaction session is gone', async () => {
    mocks.getInteractionDetails.mockRejectedValue(new Error('interaction session not found'));

    const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

    expect(response.status).toBe(400);
    expect(mocks.getInteractionResult).not.toHaveBeenCalled();
  });

  it('returns 400 session_changed when the provider session behind the interaction has ended', async () => {
    mocks.getInteractionDetails.mockRejectedValue(new errors.SessionNotFound('invalid_request'));

    const response = await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'session_changed' });
    expect(mocks.getInteractionResult).not.toHaveBeenCalled();
  });

  describe('acceptance review client', () => {
    const RESOURCE = 'urn:lobehub:acceptance:7f0c9a7e-0000-4000-8000-000000000001';

    beforeEach(() => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-review', resource: RESOURCE },
        prompt: {
          details: { missingResourceScopes: { [RESOURCE]: ['acceptance:review'] } },
          name: 'consent',
        },
        session: { accountId: 'user-1' },
        uid: 'uid-1',
      });
      mocks.findOrCreateGrants.mockResolvedValue({
        addOIDCClaims: vi.fn(),
        addOIDCScope: vi.fn(),
        addResourceScope: vi.fn(),
        save: vi.fn(async () => 'grant-1'),
      });
    });

    it('denies the grant when the reviewer cannot read the acceptance', async () => {
      mocks.resolveReviewAccess.mockResolvedValue(null);

      await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
        error: 'access_denied',
        error_description: 'No access to this acceptance',
      });
      expect(mocks.findOrCreateGrants).not.toHaveBeenCalled();
    });

    it('grants a reviewer who can read the acceptance', async () => {
      mocks.resolveReviewAccess.mockResolvedValue({ acceptance: {}, can: {} });

      await POST(createRequest({ consent: 'accept', uid: 'uid-1' }));

      expect(mocks.resolveReviewAccess).toHaveBeenCalledWith(
        {},
        'user-1',
        '7f0c9a7e-0000-4000-8000-000000000001',
      );
      expect(mocks.getInteractionResult).toHaveBeenCalledWith('uid-1', {
        consent: { grantId: 'grant-1' },
      });
    });
  });
});
