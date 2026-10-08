import { beforeEach, expect, it, vi } from 'vitest';

import { createOIDCProvider } from './provider';

const state = vi.hoisted(() => ({ config: undefined as any, access: vi.fn(), findUser: vi.fn() }));
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: state.access,
  isBusinessAuthorizationError: (error: any) =>
    ['PLATFORM_ACCESS_DENIED', 'AUTHORIZATION_UNAVAILABLE'].includes(error?.code),
}));
vi.mock('oidc-provider', () => ({
  default: class {
    constructor(_issuer: string, config: unknown) {
      state.config = config;
    }
    on() {}
  },
  errors: {},
}));
vi.mock('@/database/models/user', () => ({ UserModel: { findById: state.findUser } }));
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'http://localhost:3000' } }));
vi.mock('@/libs/oidc-provider/jwt', () => ({ getJWKS: () => ({ keys: [] }) }));
vi.mock('@/locales/resources', () => ({ normalizeLocale: (locale: string) => locale }));
vi.mock('./adapter', () => ({ DrizzleAdapter: { createAdapterFactory: () => class {} } }));
vi.mock('./config', () => ({
  defaultClaims: {},
  defaultClients: [],
  defaultScopes: ['openid', 'email'],
}));
vi.mock('./cookies', () => ({ getOIDCCookieKeys: () => ['test-secret'] }));
vi.mock('./interaction-policy', () => ({ createInteractionPolicy: () => [] }));
beforeEach(async () => {
  state.access.mockResolvedValue(undefined);
  state.findUser.mockResolvedValue({ id: 'alice', email: 'current@example.com', banned: false });
  await createOIDCProvider({} as never);
});
it.each([403, 503])(
  'findAccount preserves platform %s for provider token/refresh/userinfo consumers',
  async (status) => {
    const error = Object.assign(new Error('platform'), {
      status,
      code: status === 503 ? 'AUTHORIZATION_UNAVAILABLE' : 'PLATFORM_ACCESS_DENIED',
    });
    state.access.mockRejectedValueOnce(error);
    await expect(state.config.findAccount({ oidc: {} }, 'alice')).rejects.toBe(error);
    expect(error).toMatchObject({ statusCode: status });
  },
);
it('findAccount checks the current account before returning claims', async () => {
  const account = await state.config.findAccount({ oidc: {} }, 'alice');
  expect(state.access).toHaveBeenCalledWith({}, 'alice');
  expect(await account.claims('userinfo', 'email')).toMatchObject({
    email: 'current@example.com',
    sub: 'alice',
  });
});
it('findAccount reports unavailable when the current user lookup fails', async () => {
  state.findUser.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(state.config.findAccount({ oidc: {} }, 'alice')).rejects.toMatchObject({
    statusCode: 503,
  });
});
