// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appEnv, getSession, getUserInfo, marketSdkConstructor } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id',
    MARKET_TRUSTED_CLIENT_SECRET: 'client-secret',
  },
  getSession: vi.fn(),
  getUserInfo: vi.fn(),
  marketSdkConstructor: vi.fn(),
}));

vi.mock('@/envs/app', () => ({ appEnv }));
vi.mock('@/database/models/user', () => ({ UserModel: { findById: vi.fn() } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/auth', () => ({ auth: { api: { getSession } } }));
// The tenant gate only establishes scope and admission; the route is what is tested.
vi.mock('@/server/modules/Tenant/gate', () => ({
  withTenantRequest:
    <Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      runWithTenantScope(
        {
          session: {},
          slug: 'a',
          tenantId: '0f8b1c52-6a3e-4c7d-9a41-2d5e7b9c3a10',
        } as unknown as TenantScope,
        () => handler(...args),
      ),
}));
vi.mock('@/server/services/redis', () => ({ redisService: {} }));
vi.mock('@/server/services/sandbox/storageFiles', () => ({ createSandboxStorageClient: vi.fn() }));
vi.mock('@lobehub/market-sdk', () => ({
  MarketSDK: vi.fn(function (options: unknown) {
    marketSdkConstructor(options);
    return { user: { getUserInfo } };
  }),
  buildTrustedClientPayload: (params: Record<string, unknown>) => ({ ...params, nonce: 'n' }),
  // Like the private SDK: the payload's clientId goes in front of the ciphertext as the kid.
  createTrustedClientToken: (payload: { clientId: string }) => `${payload.clientId}.signed-token`,
  orgRefToPathSegment: vi.fn(),
}));

const { GET } = await import('./route');

const call = () =>
  GET(new NextRequest('https://tenant.test/market/user/ada'), {
    params: Promise.resolve({ username: 'ada' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getUserInfo.mockResolvedValue({ user: { id: 1, namespace: 'ada' } });
  getSession.mockResolvedValue({ user: { email: 'a@b.com', id: 'user_1', name: 'Ada' } });
});

describe('GET /market/user/[username]', () => {
  it('goes out with the signed-in visitor’s trust token', async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(marketSdkConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ trustedClientToken: 'client-id.signed-token' }),
    );
  });

  it('still reads a signed-out visitor as anonymous', async () => {
    getSession.mockResolvedValue(null);

    const response = await call();

    expect(response.status).toBe(200);
    expect(marketSdkConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ trustedClientToken: undefined }),
    );
  });

  // The visitor may well be signed in: a failed lookup must not turn into an
  // anonymous read of the default instance's public profile.
  it('sends nothing to Market when the session lookup itself fails', async () => {
    getSession.mockRejectedValue(new Error('session store down'));

    await expect(call()).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });

    expect(marketSdkConstructor).not.toHaveBeenCalled();
    expect(getUserInfo).not.toHaveBeenCalled();
  });
});
