/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { errors } from 'oidc-provider';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  authEnv: { ENABLE_OIDC: true },
  getConsentClientMetadata: vi.fn(),
  getInteractionDetails: vi.fn(),
  findUserById: vi.fn(),
  getSession: vi.fn(),
  resolveReviewAccess: vi.fn(),
}));

vi.mock('@/auth', () => ({
  getTenantAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock('@/database/models/user', () => ({ UserModel: { findById: mocks.findUserById } }));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

vi.mock('@/server/services/acceptanceReview/access', () => ({
  resolveReviewAccess: mocks.resolveReviewAccess,
}));

vi.mock('debug', () => ({
  default: () => vi.fn(),
}));

vi.mock('@/envs/auth', () => ({
  authEnv: mocks.authEnv,
}));

vi.mock('@/server/services/oidc', () => ({
  OIDCService: {
    initialize: vi.fn(async () => ({
      getConsentClientMetadata: mocks.getConsentClientMetadata,
      getInteractionDetails: mocks.getInteractionDetails,
    })),
  },
}));

const SESSION_CREATED_AT_MS = 1_700_000_000_999;

const signedIn = (
  userId: string,
  { cookies = [], user = {} }: { cookies?: string[]; user?: Record<string, unknown> } = {},
) =>
  mocks.getSession.mockResolvedValue({
    headers: new Headers(cookies.map((cookie) => ['set-cookie', cookie])),
    response: {
      session: { createdAt: new Date(SESSION_CREATED_AT_MS) },
      user: { id: userId, ...user },
    },
  });

const signedOut = (cookies: string[] = []) =>
  mocks.getSession.mockResolvedValue({
    headers: new Headers(cookies.map((cookie) => ['set-cookie', cookie])),
    response: null,
  });

const createRequest = (uid: string) =>
  new Request(`https://example.com/oidc/interaction/${uid}`) as unknown as NextRequest;

const createProps = (uid: string) => ({ params: Promise.resolve({ uid }) });

describe('GET /oidc/interaction/[uid]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authEnv.ENABLE_OIDC = true;
    signedIn('user-1');
  });

  it('returns 404 when OIDC is not enabled', async () => {
    mocks.authEnv.ENABLE_OIDC = false;

    const response = await GET(createRequest('uid-1'), createProps('uid-1'));

    expect(response.status).toBe(404);
    expect(mocks.getInteractionDetails).not.toHaveBeenCalled();
  });

  it('returns interaction details for a consent prompt with a first-party client', async () => {
    mocks.getInteractionDetails.mockResolvedValue({
      params: {
        client_id: 'lobehub-desktop',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid profile email',
      },
      prompt: { name: 'consent' },
      session: { accountId: 'user-1' },
      uid: 'uid-1',
    });
    mocks.getConsentClientMetadata.mockResolvedValue({
      clientName: 'LobeHub Desktop',
      isFirstParty: true,
      logo: 'https://example.com/logo.png',
    });

    const response = await GET(createRequest('uid-1'), createProps('uid-1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      clientId: 'lobehub-desktop',
      clientMetadata: {
        clientName: 'LobeHub Desktop',
        isFirstParty: true,
        logo: 'https://example.com/logo.png',
      },
      prompt: 'consent',
      redirectUri: 'https://example.com/callback',
      scopes: ['openid', 'profile', 'email'],
      uid: 'uid-1',
    });
    expect(mocks.getInteractionDetails).toHaveBeenCalledWith('uid-1');
    expect(mocks.getConsentClientMetadata).toHaveBeenCalledWith('lobehub-desktop');
  });

  it('passes through third-party client metadata with developer info', async () => {
    mocks.getInteractionDetails.mockResolvedValue({
      params: {
        client_id: 'lca_thirdparty',
        redirect_uri: 'https://third.party/cb',
        scope: 'openid',
      },
      prompt: { name: 'consent' },
      session: { accountId: 'user-1' },
      uid: 'uid-2',
    });
    mocks.getConsentClientMetadata.mockResolvedValue({
      clientName: 'Third Party App',
      developerName: 'Jane Doe',
      isFirstParty: false,
      policyUri: 'https://third.party/privacy',
    });

    const response = await GET(createRequest('uid-2'), createProps('uid-2'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.clientMetadata).toEqual({
      clientName: 'Third Party App',
      developerName: 'Jane Doe',
      isFirstParty: false,
      policyUri: 'https://third.party/privacy',
    });
    expect(body.clientId).toBe('lca_thirdparty');
  });

  it('returns interaction details for a login prompt', async () => {
    mocks.getInteractionDetails.mockResolvedValue({
      params: { client_id: 'lobehub-desktop' },
      prompt: { name: 'login' },
      uid: 'uid-3',
    });
    mocks.getConsentClientMetadata.mockResolvedValue({
      clientName: 'LobeHub Desktop',
      isFirstParty: true,
    });

    const response = await GET(createRequest('uid-3'), createProps('uid-3'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.prompt).toBe('login');
    expect(body.scopes).toEqual([]);
    expect(body.uid).toBe('uid-3');
  });

  it('returns 409 for unsupported interaction prompts', async () => {
    mocks.getInteractionDetails.mockResolvedValue({
      params: {},
      prompt: { name: 'select_account' },
      uid: 'uid-4',
    });

    const response = await GET(createRequest('uid-4'), createProps('uid-4'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'unsupported_interaction',
      promptName: 'select_account',
    });
  });

  it('returns 400 when the interaction session is not found', async () => {
    mocks.getInteractionDetails.mockRejectedValue(new Error('interaction session not found'));

    const response = await GET(createRequest('uid-5'), createProps('uid-5'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'session_invalid' });
  });

  it('returns 400 session_changed when the provider session behind the interaction has ended', async () => {
    mocks.getInteractionDetails.mockRejectedValue(new errors.SessionNotFound('invalid_request'));

    const response = await GET(createRequest('uid-5'), createProps('uid-5'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'session_changed' });
  });

  it('returns 400 when the interaction behind the cookie is not the one asked for', async () => {
    mocks.getInteractionDetails.mockResolvedValue({
      params: { client_id: 'lobehub-desktop' },
      prompt: { name: 'consent' },
      session: { accountId: 'user-1' },
      uid: 'another-uid',
    });

    const response = await GET(createRequest('uid-7'), createProps('uid-7'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'session_invalid' });
  });

  describe('the consent card of the signed-in account', () => {
    const cookies = ['better-auth.session_token=fresh; Path=/', 'better-auth.other=1; Path=/'];

    beforeEach(() => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-desktop', scope: 'openid' },
        prompt: { name: 'consent' },
        session: { accountId: 'user-1' },
        uid: 'uid-8',
      });
      mocks.getConsentClientMetadata.mockResolvedValue({});
      signedIn('user-1', {
        cookies,
        user: { email: 'session@example.com', image: 'https://example.com/s.png', name: 'Session' },
      });
      mocks.findUserById.mockResolvedValue({
        avatar: 'https://example.com/a.png',
        email: 'alice@example.com',
        fullName: 'Alice A',
        id: 'user-1',
        username: 'alice',
      });
    });

    it('names the account from the tenant user row and forwards every session cookie', async () => {
      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        account: {
          avatar: 'https://example.com/a.png',
          email: 'alice@example.com',
          name: 'Alice A',
        },
      });
      expect(mocks.findUserById).toHaveBeenCalledWith({}, 'user-1');
      expect(response.headers.getSetCookie()).toEqual(cookies);
    });

    it.each([
      ['the account row is not found', () => mocks.findUserById.mockResolvedValue(undefined)],
      ['the lookup fails', () => mocks.findUserById.mockRejectedValue(new Error('db down'))],
    ])('names the account from the session user when %s', async (_name, arrange) => {
      arrange();

      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        account: {
          avatar: 'https://example.com/s.png',
          email: 'session@example.com',
          name: 'Session',
        },
      });
    });

    it('fills what the row lacks from the session user', async () => {
      mocks.findUserById.mockResolvedValue({ email: 'alice@example.com', id: 'user-1' });

      const body = await (await GET(createRequest('uid-8'), createProps('uid-8'))).json();

      expect(body.account).toEqual({
        avatar: 'https://example.com/s.png',
        email: 'alice@example.com',
        name: 'Session',
      });
    });

    it('leaves the account out when neither source has a name or an email', async () => {
      signedIn('user-1', { cookies });
      mocks.findUserById.mockResolvedValue({ avatar: 'https://example.com/a.png', id: 'user-1' });

      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty('account');
      expect(response.headers.getSetCookie()).toEqual(cookies);
    });

    it.each([
      ['another account is signed in', () => signedIn('user-2', { cookies })],
      ['nobody is signed in', () => signedOut(cookies)],
    ])(
      'answers 400 session_changed when %s, with the cookies and no account lookup',
      async (_name, arrange) => {
        arrange();

        const response = await GET(createRequest('uid-8'), createProps('uid-8'));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'session_changed' });
        expect(response.headers.getSetCookie()).toEqual(cookies);
        expect(mocks.findUserById).not.toHaveBeenCalled();
      },
    );

    it('answers 400 session_changed when the provider session holds no account', async () => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-desktop', scope: 'openid' },
        prompt: { name: 'consent' },
        uid: 'uid-8',
      });

      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'session_changed' });
    });

    it('answers 503 session_unavailable when the session cannot be read, never as a sign-out', async () => {
      mocks.getSession.mockRejectedValue(new Error('database down'));

      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'session_unavailable' });
      expect(mocks.findUserById).not.toHaveBeenCalled();
    });

    it('answers 503 and still forwards the cookies when the session time is unusable', async () => {
      mocks.getSession.mockResolvedValue({
        headers: new Headers(cookies.map((cookie) => ['set-cookie', cookie])),
        response: { session: { createdAt: 'not a date' }, user: { id: 'user-1' } },
      });

      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'session_unavailable' });
      expect(response.headers.getSetCookie()).toEqual(cookies);
    });

    it('keeps the cookies on the 500 when something fails after the session was read', async () => {
      mocks.getConsentClientMetadata.mockRejectedValue(new Error('x'));

      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual(cookies);
    });

    it('does not read the session or the account for a login prompt', async () => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-desktop' },
        prompt: { name: 'login' },
        session: { accountId: 'user-1' },
        uid: 'uid-8',
      });

      const response = await GET(createRequest('uid-8'), createProps('uid-8'));

      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty('account');
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.findUserById).not.toHaveBeenCalled();
    });
  });

  it('returns 500 on unexpected errors', async () => {
    mocks.getInteractionDetails.mockRejectedValue(new Error('database exploded'));

    const response = await GET(createRequest('uid-6'), createProps('uid-6'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'server_error' });
  });

  describe('acceptance review client', () => {
    const RESOURCE = 'urn:lobehub:acceptance:7f0c9a7e-0000-4000-8000-000000000001';

    beforeEach(() => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-review', resource: RESOURCE, scope: 'acceptance:review' },
        prompt: { name: 'consent' },
        session: { accountId: 'user-1' },
        uid: 'uid-r',
      });
      mocks.getConsentClientMetadata.mockResolvedValue({ clientName: 'LobeHub Review' });
    });

    it('names the acceptance the reviewer is about to open', async () => {
      mocks.resolveReviewAccess.mockResolvedValue({
        acceptance: { metadata: { title: 'Billing redesign' }, requirement: 'r' },
        can: { comment: true, decide: false, moderate: false },
      });

      const response = await GET(createRequest('uid-r'), createProps('uid-r'));

      await expect(response.json()).resolves.toMatchObject({
        acceptanceReview: { allowed: true, title: 'Billing redesign' },
      });
      expect(mocks.resolveReviewAccess).toHaveBeenCalledWith(
        {},
        'user-1',
        '7f0c9a7e-0000-4000-8000-000000000001',
      );
    });

    it('says nothing about an acceptance the reviewer cannot read', async () => {
      mocks.resolveReviewAccess.mockResolvedValue(null);

      const response = await GET(createRequest('uid-r'), createProps('uid-r'));
      const body = await response.json();

      expect(body.acceptanceReview).toEqual({ allowed: false });
    });

    it('is not looked up for other clients', async () => {
      mocks.getInteractionDetails.mockResolvedValue({
        params: { client_id: 'lobehub-desktop', scope: 'openid' },
        prompt: { name: 'consent' },
        session: { accountId: 'user-1' },
        uid: 'uid-d',
      });

      const response = await GET(createRequest('uid-d'), createProps('uid-d'));

      expect((await response.json()).acceptanceReview).toBeUndefined();
      expect(mocks.resolveReviewAccess).not.toHaveBeenCalled();
    });
  });
});
