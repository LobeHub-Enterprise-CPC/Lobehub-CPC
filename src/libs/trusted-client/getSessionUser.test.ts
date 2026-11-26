// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appEnv, getSession } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id' as string | undefined,
    MARKET_TRUSTED_CLIENT_SECRET: 'client-secret' as string | undefined,
  },
  getSession: vi.fn(),
}));

vi.mock('@/envs/app', () => ({ appEnv }));
vi.mock('@/database/models/user', () => ({ UserModel: { findById: vi.fn() } }));
vi.mock('@lobechat/business-auth', () => ({
  resolveBusinessOrgUnitIds: vi.fn(async () => ['unit-rd', 'unit-root']),
}));
vi.mock('@lobehub/market-sdk', () => ({
  buildTrustedClientPayload: vi.fn(),
  createTrustedClientToken: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/auth', () => ({ auth: { api: { getSession } } }));

const { getSessionUser } = await import('./getSessionUser');
const { TrustedClientIdentityError } = await import('./errors');
const { headers } = await import('next/headers');

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

beforeEach(() => {
  vi.clearAllMocks();
  appEnv.MARKET_TRUSTED_CLIENT_SECRET = 'client-secret';
  getSession.mockResolvedValue({ user: { email: 'a@b.com', id: 'user_1', name: 'Ada' } });
});

describe('getSessionUser', () => {
  it('returns the session user with the tenant of the request', async () => {
    await expect(inTenant('tenant-a', getSessionUser)).resolves.toEqual({
      email: 'a@b.com',
      name: 'Ada',
      orgUnitIds: ['unit-rd', 'unit-root'],
      tenantId: 'tenant-a',
      userId: 'user_1',
    });
  });

  it('leaves a due session for the auth endpoint to renew on a response with cookies', async () => {
    const database = {
      account: [],
      session: [] as { expiresAt: Date }[],
      user: [],
      verification: [],
    };
    const baseURL = 'http://localhost:3000';
    const auth = betterAuth({
      baseURL,
      database: memoryAdapter(database),
      emailAndPassword: { enabled: true },
      secret: 'test-secret-test-secret-test-secret',
    });
    const { headers: signUpHeaders } = await auth.api.signUpEmail({
      body: { email: 'a@b.com', name: 'Ada', password: 'session-fixture-password' },
      returnHeaders: true,
    });
    const cookie = signUpHeaders.getSetCookie()[0].split(';')[0];
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    database.session[0].expiresAt = expiry;
    const requestHeaders = new Headers({ cookie });
    getSession.mockImplementationOnce(auth.api.getSession);
    vi.mocked(headers).mockResolvedValueOnce(requestHeaders);

    await expect(inTenant('tenant-a', getSessionUser)).resolves.toMatchObject({ email: 'a@b.com' });
    expect(database.session[0].expiresAt).toEqual(expiry);

    const renewed = await auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: requestHeaders,
      }),
    );

    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ user: { email: 'a@b.com' } });
    expect(renewed.headers.getSetCookie()).toEqual([
      expect.stringContaining('better-auth.session_token='),
    ]);
    expect(database.session[0].expiresAt.getTime()).toBeGreaterThan(expiry.getTime());
  });

  it('is undefined for a signed-out visitor', async () => {
    getSession.mockResolvedValue(null);

    await expect(inTenant('tenant-a', getSessionUser)).resolves.toBeUndefined();
  });

  // Without the tenant the session lookup itself cannot work; reporting that as
  // "signed out" would send the visitor to Market anonymously.
  it('fails instead of reading as signed out when there is no tenant', async () => {
    await expect(getSessionUser()).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('does not demand a tenant when trusted client is not enabled', async () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;

    await expect(getSessionUser()).resolves.toMatchObject({ userId: 'user_1' });
  });

  // A lookup that throws says nothing about whether the visitor is signed in.
  // Reading it as "signed out" would send a signed-in request to Market with no
  // credentials, i.e. to the default instance's public catalogue.
  describe('when the session lookup fails', () => {
    it('fails instead of reading as signed out, in a tenant', async () => {
      getSession.mockRejectedValue(new Error('session store down'));

      await expect(inTenant('tenant-a', getSessionUser)).rejects.toMatchObject({
        code: 'SESSION_UNAVAILABLE',
      });
    });

    it('fails the same way when trusted client is not enabled', async () => {
      appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
      getSession.mockRejectedValue(new Error('session store down'));

      await expect(getSessionUser()).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    });

    it('fails when the request headers cannot be read', async () => {
      vi.mocked(headers).mockRejectedValueOnce(new Error('no request context'));

      await expect(inTenant('tenant-a', getSessionUser)).rejects.toMatchObject({
        code: 'SESSION_UNAVAILABLE',
      });
      expect(getSession).not.toHaveBeenCalled();
    });

    it('is a TrustedClientIdentityError that leaks nothing of the cause', async () => {
      getSession.mockRejectedValue(new Error('postgres://user:hunter2@db/auth'));

      const error = await inTenant('tenant-a', getSessionUser).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TrustedClientIdentityError);
      expect(String((error as Error).message)).not.toContain('hunter2');
      expect((error as Error).cause).toBeUndefined();
    });

    it('still reads a null session as a signed-out visitor, with or without trust', async () => {
      getSession.mockResolvedValue(null);
      await expect(inTenant('tenant-a', getSessionUser)).resolves.toBeUndefined();

      appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
      await expect(getSessionUser()).resolves.toBeUndefined();
    });
  });
});
