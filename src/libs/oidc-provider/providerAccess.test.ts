import { beforeEach, expect, it, vi } from 'vitest';

import { createOIDCProvider } from './provider';

const state = vi.hoisted(() => ({
  issuer: '',
  config: undefined as any,
  access: vi.fn(),
  findUser: vi.fn(),
}));
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: state.access,
  isBusinessAuthorizationError: (error: any) =>
    ['PLATFORM_ACCESS_DENIED', 'AUTHORIZATION_UNAVAILABLE'].includes(error?.code),
}));
vi.mock('oidc-provider', () => ({
  default: class {
    constructor(issuer: string, config: unknown) {
      state.issuer = issuer;
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
  defaultClients: [
    {
      client_id: 'lobehub-desktop',
      redirect_uris: [
        'https://app.lobehub.com/oidc/callback/desktop',
        'https://lobehub.com/oidc/callback/desktop',
        'http://localhost:3210/oidc/callback/desktop',
      ],
      post_logout_redirect_uris: [
        'https://app.lobehub.com/oauth/logout',
        'https://lobehub.com/oauth/logout',
        'http://localhost:3210/oauth/logout',
      ],
    },
    { client_id: 'lobehub-mobile', redirect_uris: ['com.lobehub.app://auth/callback'] },
  ],
  defaultScopes: ['openid', 'email'],
}));
vi.mock('./cookies', () => ({ getOIDCCookieKeys: () => ['test-secret'] }));
vi.mock('./interaction-policy', () => ({ createInteractionPolicy: () => [] }));
const acme = {
  endpoint: { basePath: '/t/acme', publicUrl: 'http://localhost:3000/t/acme', version: 1 },
  tenantId: 'tenant-acme',
};

beforeEach(async () => {
  state.access.mockResolvedValue(undefined);
  state.findUser.mockResolvedValue({ id: 'alice', email: 'current@example.com', banned: false });
  await createOIDCProvider({} as never, acme);
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

it('keeps the issuer, device endpoints, cookies and redirects within a tenant', async () => {
  await createOIDCProvider({} as never, acme);
  expect(state.issuer).toBe('http://localhost:3000/t/acme/oidc');
  expect(state.config.routes.device_authorization).toBe('/t/acme/oidc/device/auth');
  expect(state.config.cookies.long.path).toBe('/t/acme');
  expect(state.config.cookies.short.path).toBe('/t/acme');
  const redirect = vi.fn();
  await state.config.features.deviceFlow.successSource({ redirect });
  expect(redirect).toHaveBeenCalledWith('/t/acme/oauth/device/success');
  expect(state.config.interactions.url({ oidc: {} }, { uid: 'consent-1' })).toBe(
    '/t/acme/oauth/consent/consent-1',
  );
});

it('stamps the owning tenant id on every access token its provider issues', async () => {
  await createOIDCProvider({} as never, acme);
  expect(await state.config.extraTokenClaims({ oidc: {} }, {})).toEqual({ tid: 'tenant-acme' });
});

it.each([
  {
    basePath: '/t/acme',
    publicUrl: 'https://app.example.com/t/acme',
    version: 1,
    cookiePath: '/t/acme',
  },
  { basePath: '', publicUrl: 'https://chat.example.com', version: 2, cookiePath: '/' },
])('uses canonical issuer, cookie path and protocol routes on $publicUrl', async (endpoint) => {
  await createOIDCProvider({} as never, { endpoint, tenantId: 'tenant-acme' });
  expect(state.issuer).toBe(`${endpoint.publicUrl}/oidc`);
  expect(state.config.cookies.long.path).toBe(endpoint.cookiePath);
  expect(state.config.cookies.short.path).toBe(endpoint.cookiePath);
  expect(state.config.routes.authorization).toBe(`${endpoint.basePath}/oidc/auth`);
  expect(state.config.clients[0].redirect_uris).toEqual([
    'https://app.lobehub.com/oidc/callback/desktop',
    'https://lobehub.com/oidc/callback/desktop',
    'http://localhost:3210/oidc/callback/desktop',
    `${endpoint.publicUrl}/oidc/callback/desktop`,
  ]);
  expect(state.config.clients[0].post_logout_redirect_uris).toEqual([
    'https://app.lobehub.com/oauth/logout',
    'https://lobehub.com/oauth/logout',
    'http://localhost:3210/oauth/logout',
    `${endpoint.publicUrl}/oauth/logout`,
  ]);
  expect(state.config.clients[1].redirect_uris).toEqual(['com.lobehub.app://auth/callback']);
  expect(state.config.interactions.url({ oidc: {} }, { uid: 'consent-1' })).toBe(
    `${endpoint.basePath}/oauth/consent/consent-1`,
  );
});

it('deduplicates canonical desktop callbacks without mutating another tenant provider', async () => {
  const endpoint = { basePath: '', publicUrl: 'https://lobehub.com', version: 1 };
  await createOIDCProvider({} as never, { endpoint, tenantId: 'tenant-acme' });
  expect(state.config.clients[0].redirect_uris).toHaveLength(3);
  await createOIDCProvider({} as never, acme);
  expect(state.config.clients[0].redirect_uris).toEqual([
    'https://app.lobehub.com/oidc/callback/desktop',
    'https://lobehub.com/oidc/callback/desktop',
    'http://localhost:3210/oidc/callback/desktop',
    'http://localhost:3000/t/acme/oidc/callback/desktop',
  ]);
});
