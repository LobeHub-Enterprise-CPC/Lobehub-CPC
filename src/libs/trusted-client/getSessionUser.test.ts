import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
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
      tenantId: 'tenant-a',
      userId: 'user_1',
    });
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
