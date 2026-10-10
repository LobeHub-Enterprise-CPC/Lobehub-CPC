import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const authHandler = vi.fn(async () => new Response(null));

  return {
    managedBusinessSSO: false,
    appEnv: { APP_URL: 'https://example.com' },
    authHandler,
    betterAuth: vi.fn((options) => ({ ...options, handler: authHandler })),
    clearMismatchedOIDCSession: vi.fn(),
    EnvHttpProxyAgent: vi.fn(function (options) {
      return { options };
    }),
    passkey: vi.fn(() => ({ id: 'passkey' })),
    setGlobalDispatcher: vi.fn(),
  };
});

vi.mock('@lobechat/business-auth', () => ({
  configureBusinessAuth: (options: unknown) => options,
  get managedBusinessSSO() {
    return mocks.managedBusinessSSO;
  },
}));

vi.mock('@better-auth/expo', () => ({
  expo: vi.fn(() => ({ id: 'expo' })),
}));

vi.mock('@better-auth/passkey', () => ({
  passkey: mocks.passkey,
}));

vi.mock('@lobechat/database', () => ({
  createNanoId: vi.fn(() => vi.fn(() => 'generated-id')),
  idGenerator: vi.fn(() => 'generated-user-id'),
}));

vi.mock('@lobechat/database/schemas', () => ({}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: vi.fn(() => ({ id: 'drizzle-adapter' })),
}));

vi.mock('better-auth/crypto', () => ({
  verifyPassword: vi.fn(),
}));

vi.mock('better-auth/minimal', () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock('better-auth/plugins', () => ({
  admin: vi.fn(() => ({ id: 'admin' })),
  emailOTP: vi.fn(() => ({ id: 'email-otp' })),
  genericOAuth: vi.fn(() => ({ id: 'generic-oauth' })),
  magicLink: vi.fn(() => ({ id: 'magic-link' })),
}));

vi.mock('undici', () => ({
  EnvHttpProxyAgent: mocks.EnvHttpProxyAgent,
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

vi.mock('@/envs/app', () => ({
  appEnv: mocks.appEnv,
}));

vi.mock('@/envs/auth', () => ({
  authEnv: {
    AUTH_DISABLE_EMAIL_PASSWORD: false,
    AUTH_EMAIL_VERIFICATION: true,
    AUTH_ENABLE_MAGIC_LINK: false,
    AUTH_SECRET: 'test-secret',
  },
}));

vi.mock('@/libs/better-auth/email-templates', () => ({
  getChangeEmailVerificationTemplate: vi.fn(() => ({})),
  getMagicLinkEmailTemplate: vi.fn(() => ({})),
  getResetPasswordEmailTemplate: vi.fn(() => ({})),
  getVerificationEmailTemplate: vi.fn(() => ({})),
  getVerificationOTPEmailTemplate: vi.fn(() => ({})),
}));

vi.mock('@/libs/better-auth/utils/config', () => ({
  createSecondaryStorage: vi.fn(() => ({ id: 'secondary-storage' })),
  getPasskeyOrigins: vi.fn(() => ['https://example.com']),
  getTrustedOrigins: vi.fn(() => ['https://example.com']),
}));

vi.mock('@/libs/oidc-provider/session-cleanup', () => ({
  clearMismatchedOIDCSession: mocks.clearMismatchedOIDCSession,
}));

vi.mock('@/server/services/email', () => ({
  EmailService: vi.fn(),
}));

vi.mock('@/server/services/user', () => ({
  UserService: vi.fn(),
}));

const tenantDatabase = { id: 'tenant-db' } as never;

const tenantOptions = () => ({
  cookiePrefix: 'lh_test',
  database: tenantDatabase,
  genericOAuthProviders: [],
  plugins: [],
  secondaryStorageNamespace: 'tenant-1',
  socialProviders: {},
  tenant: { id: 'tenant-1', slug: 'acme' },
});

describe('defineConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.appEnv.APP_URL = 'https://example.com';
    mocks.managedBusinessSSO = false;
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('should configure passkeys with the approved origins', async () => {
    const { defineConfig } = await import('./define-config');

    defineConfig(tenantOptions());

    expect(mocks.passkey).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: ['https://example.com'],
        rpID: 'example.com',
        rpName: 'LobeHub',
      }),
    );
  });

  it('does not restrict sign-up by a deployment-wide email allow list', async () => {
    process.env.AUTH_ALLOWED_EMAILS = 'example.com';
    const { defineConfig } = await import('./define-config');

    defineConfig(tenantOptions());

    const options = mocks.betterAuth.mock.calls[0][0];
    expect(options.plugins.map((plugin: { id: string }) => plugin.id)).not.toContain(
      'email-whitelist',
    );
  });

  it('disables social login in managed distributions while preserving base session configuration', async () => {
    mocks.managedBusinessSSO = true;
    const { defineConfig } = await import('./define-config');
    defineConfig({
      ...tenantOptions(),
      plugins: [{ id: 'business-admission' }],
      overrides: {
        plugins: [{ id: 'enterprise-sso-request' }],
        verification: { storeInDatabase: true },
        account: { accountLinking: { enabled: false }, storeStateStrategy: 'database' },
        advanced: { cookies: { state: { name: 'provider-state' } } },
        trustedOrigins: ['https://idp.example.com'],
      },
    });
    const [options] = mocks.betterAuth.mock.lastCall!;
    expect(options.socialProviders).toEqual({});
    expect(options.account.accountLinking.enabled).toBe(false);
    expect(options.disabledPaths).toContain('/sign-in/social');
    expect(options.disabledPaths).toContain('/get-access-token');
    expect(options.verification.storeInDatabase).toBe(true);
    expect(options.advanced.cookiePrefix).toBe('lh_test');
    expect(options.session.storeSessionInDatabase).toBe(true);
    expect(options.user.additionalFields.username.type).toBe('string');
    expect(options.plugins.map((plugin: { id: string }) => plugin.id)).toContain(
      'enterprise-sso-request',
    );
    expect(options.plugins.map((plugin: { id: string }) => plugin.id)).not.toContain(
      'email-whitelist',
    );
  });

  it('should revoke existing sessions after password reset by default', async () => {
    const { defineConfig } = await import('./define-config');

    defineConfig(tenantOptions());

    expect(mocks.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAndPassword: expect.objectContaining({
          revokeSessionsOnPasswordReset: true,
        }),
      }),
    );
  });

  it('should clear a mismatched OIDC session before creating a Better Auth session', async () => {
    const { defineConfig } = await import('./define-config');
    const context = { getCookie: vi.fn(), setCookie: vi.fn() };

    defineConfig(tenantOptions());
    const [options] = mocks.betterAuth.mock.lastCall!;
    await options.databaseHooks.session.create.before({ userId: 'user-b' }, context);

    expect(mocks.clearMismatchedOIDCSession).toHaveBeenCalledWith(
      tenantDatabase,
      'user-b',
      context,
    );
  });

  it('should continue creating the Better Auth session when OIDC cleanup fails', async () => {
    const cleanupError = new Error('OIDC database unavailable');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.clearMismatchedOIDCSession.mockRejectedValueOnce(cleanupError);
    const { defineConfig } = await import('./define-config');

    defineConfig(tenantOptions());
    const [options] = mocks.betterAuth.mock.lastCall!;

    await expect(
      options.databaseHooks.session.create.before({ userId: 'user-b' }, null),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      '[Better Auth] Failed to clear a stale OIDC session:',
      cleanupError,
    );
  });

  it('should respect NO_PROXY when configuring the development proxy dispatcher', async () => {
    process.env = {
      ...process.env,
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NODE_ENV: 'development',
      NO_PROXY: 'example.com,localhost',
    };

    await import('./define-config');

    expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: 'example.com,localhost,127.0.0.1,[::1]',
    });
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          noProxy: 'example.com,localhost,127.0.0.1,[::1]',
        }),
      }),
    );
  });

  it('should preserve NO_PROXY wildcard semantics', async () => {
    const { mergeLocalNoProxy } = await import('./define-config');

    expect(mergeLocalNoProxy('*')).toBe('*');
  });

  it('should mount the tenant auth under its path with path-scoped, prefixed cookies', async () => {
    const { defineConfig } = await import('./define-config');

    defineConfig(tenantOptions());
    const [options] = mocks.betterAuth.mock.lastCall!;

    expect(options.basePath).toBe('/t/acme/api/auth');
    expect(options.advanced.cookiePrefix).toBe('lh_test');
    expect(options.advanced.defaultCookieAttributes).toEqual({ path: '/t/acme' });
    expect(options.advanced.crossSubDomainCookies).toBeUndefined();
    expect(options.onAPIError.errorURL).toBe('/t/acme/auth-error');
  });

  it('should never link a new provider to an existing account by email', async () => {
    const { defineConfig } = await import('./define-config');

    defineConfig(tenantOptions());
    const [options] = mocks.betterAuth.mock.lastCall!;

    expect(options.account.accountLinking.disableImplicitLinking).toBe(true);
  });

  it('should use the tenant database and session namespace', async () => {
    const { defineConfig } = await import('./define-config');
    const { createSecondaryStorage } = await import('@/libs/better-auth/utils/config');
    const { drizzleAdapter } = await import('better-auth/adapters/drizzle');

    defineConfig(tenantOptions());

    expect(createSecondaryStorage).toHaveBeenCalledWith('tenant-1');
    expect(drizzleAdapter).toHaveBeenCalledWith(tenantDatabase, expect.anything());
  });

  it("should pass the tenant's built-in providers to Better Auth and trust their origins", async () => {
    const { defineConfig } = await import('./define-config');
    const { getTrustedOrigins } = await import('@/libs/better-auth/utils/config');

    const apple = { clientId: 'apple-id', clientSecret: 'apple-secret' };
    defineConfig({ ...tenantOptions(), socialProviders: { apple } });

    const [options] = mocks.betterAuth.mock.lastCall!;
    expect(options.socialProviders).toEqual({ apple });
    expect(getTrustedOrigins).toHaveBeenLastCalledWith(['apple']);
  });

  it('should only enable generic OAuth when the tenant has SSO providers', async () => {
    const { defineConfig } = await import('./define-config');
    const { genericOAuth } = await import('better-auth/plugins');

    defineConfig(tenantOptions());
    expect(genericOAuth).not.toHaveBeenCalled();

    const provider = { clientId: 'id', clientSecret: 'secret', providerId: 'okta' };
    defineConfig({ ...tenantOptions(), genericOAuthProviders: [provider] });
    expect(genericOAuth).toHaveBeenCalledWith({ config: [provider] });
  });
});
