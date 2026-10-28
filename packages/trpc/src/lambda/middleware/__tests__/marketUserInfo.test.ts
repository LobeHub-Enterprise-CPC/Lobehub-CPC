import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appEnv, findById, getUserSettings } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id' as string | undefined,
    MARKET_TRUSTED_CLIENT_SECRET: 'client-secret' as string | undefined,
  },
  findById: vi.fn(),
  getUserSettings: vi.fn(),
}));

vi.mock('@/envs/app', () => ({ appEnv }));
vi.mock('@lobehub/market-sdk', () => ({
  buildTrustedClientPayload: vi.fn(),
  createTrustedClientToken: vi.fn(),
}));
vi.mock('@/database/models/user', () => ({
  UserModel: Object.assign(
    vi.fn(function () {
      return { getUserSettings };
    }),
    { findById },
  ),
}));
vi.mock('../../init', () => ({ trpc: { middleware: (fn: unknown) => fn } }));

const { resolveMarketUserContext } = await import('../marketUserInfo');

const serverDB = {} as never;
const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

beforeEach(() => {
  vi.clearAllMocks();
  appEnv.MARKET_TRUSTED_CLIENT_SECRET = 'client-secret';
  findById.mockResolvedValue({ email: 'ada@example.com', fullName: 'Ada', id: 'user_1' });
  getUserSettings.mockResolvedValue({ market: { accessToken: 'db-token' } });
});

describe('resolveMarketUserContext', () => {
  it('builds the identity with the tenant of the request', async () => {
    const context = await inTenant('tenant-a', () =>
      resolveMarketUserContext({ serverDB, userId: 'user_1' }),
    );

    expect(context).toEqual({
      marketAccessToken: 'db-token',
      marketUserInfo: {
        email: 'ada@example.com',
        name: 'Ada',
        tenantId: 'tenant-a',
        userId: 'user_1',
      },
    });
  });

  // R13: acting as the workspace's organization is closed inside a tenant, and
  // Market refuses a tenant token that names a workspace.
  it('does not carry the workspace into a tenant identity', async () => {
    const context = await inTenant('tenant-a', () =>
      resolveMarketUserContext({ serverDB, userId: 'user_1', workspaceId: 'wsp_1' }),
    );

    expect(context.marketUserInfo).toMatchObject({ tenantId: 'tenant-a', userId: 'user_1' });
    expect(context.marketUserInfo).not.toHaveProperty('workspaceId');
  });

  it('skips Market identity for an anonymous request', async () => {
    await expect(resolveMarketUserContext({ serverDB, userId: null })).resolves.toEqual({
      marketUserInfo: undefined,
    });
  });

  it('keeps the identity when only the optional settings row cannot be read', async () => {
    getUserSettings.mockRejectedValue(new Error('settings unavailable'));

    const context = await inTenant('tenant-a', () =>
      resolveMarketUserContext({ marketAccessToken: 'cookie-token', serverDB, userId: 'user_1' }),
    );

    expect(context.marketUserInfo).toMatchObject({ tenantId: 'tenant-a' });
    expect(context.marketAccessToken).toBe('cookie-token');
  });

  // The request must fail loudly: the alternative is reaching Market as nobody,
  // or as an OIDC user the tenant never asked for.
  describe('when the identity cannot be assembled', () => {
    it('fails with a Market identity error outside a tenant, without reading anything', async () => {
      await expect(resolveMarketUserContext({ serverDB, userId: 'user_1' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'MARKET_IDENTITY_UNAVAILABLE:TENANT_REQUIRED',
      });
      expect(findById).not.toHaveBeenCalled();
    });

    // UNAUTHORIZED would make the response ask the desktop app to sign in again,
    // and the session is not what failed.
    it('does not report a missing user as an expired session', async () => {
      findById.mockResolvedValue(undefined);

      await expect(
        inTenant('tenant-a', () => resolveMarketUserContext({ serverDB, userId: 'user_1' })),
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'MARKET_IDENTITY_UNAVAILABLE:USER_UNAVAILABLE',
      });
    });
  });

  it('carries on without an identity when trusted client is not enabled and the user is gone', async () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
    findById.mockResolvedValue(undefined);

    await expect(resolveMarketUserContext({ serverDB, userId: 'user_1' })).resolves.toEqual({
      marketUserInfo: undefined,
    });
  });
});
