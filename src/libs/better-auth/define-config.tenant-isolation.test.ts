// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Real better-auth instances on a real (PGlite) database: only the services that
// reach outside the process are replaced.
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'http://localhost:3010' } }));

vi.mock('@/envs/auth', () => ({
  authEnv: {
    AUTH_DISABLE_EMAIL_PASSWORD: false,
    AUTH_EMAIL_VERIFICATION: false,
    AUTH_ENABLE_MAGIC_LINK: false,
    AUTH_SECRET: 'tenant-isolation-test-master-secret-0123456789',
  },
}));

vi.mock('@/server/services/email', () => ({ EmailService: vi.fn() }));

vi.mock('@/server/services/user', () => ({
  UserService: vi.fn(function () {
    return { initUser: vi.fn() };
  }),
}));

vi.mock('@/libs/oidc-provider/session-cleanup', () => ({
  clearMismatchedOIDCSession: vi.fn(),
}));

const { defineConfig } = await import('./define-config');

const tenantAuth = async (id: string) =>
  defineConfig({
    cookiePrefix: `lh_${id}`,
    database: await getTestDB(),
    genericOAuthProviders: [],
    plugins: [],
    secondaryStorageNamespace: `t:${id}`,
    socialProviders: {},
    tenant: { id, slug: id },
  });

type TenantAuth = Awaited<ReturnType<typeof tenantAuth>>;

const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

/** What a hostile client does: rename every cookie of tenant A to tenant B's prefix. */
const replayOnTenant = (cookieHeader: string, from: string, to: string) =>
  new Headers({ cookie: cookieHeader.replaceAll(`lh_${from}.`, `lh_${to}.`) });

describe('tenant auth isolation', () => {
  let tenantA: TenantAuth;
  let tenantB: TenantAuth;
  let sessionCookies: string;

  beforeAll(async () => {
    tenantA = await tenantAuth('tenant-a');
    tenantB = await tenantAuth('tenant-b');

    const response = await tenantA.api.signUpEmail({
      asResponse: true,
      body: { email: 'alice@example.com', name: 'Alice', password: 'correct-horse-battery' },
    });
    sessionCookies = cookieHeaderOf(response);
  });

  it('issues both the signed session token and the session_data cache cookie', () => {
    expect(sessionCookies).toContain('lh_tenant-a.session_token=');
    expect(sessionCookies).toContain('lh_tenant-a.session_data=');
  });

  it('accepts a tenant session on the tenant that issued it', async () => {
    const session = await tenantA.api.getSession({
      headers: new Headers({ cookie: sessionCookies }),
    });

    expect(session?.user.email).toBe('alice@example.com');
  });

  it('rejects tenant A session cookies renamed to tenant B', async () => {
    const session = await tenantB.api.getSession({
      headers: replayOnTenant(sessionCookies, 'tenant-a', 'tenant-b'),
    });

    expect(session).toBeNull();
  });

  it('rejects a tenant A session token alone renamed to tenant B', async () => {
    const tokenOnly = sessionCookies
      .split('; ')
      .filter((cookie) => cookie.startsWith('lh_tenant-a.session_token='))
      .join('; ');

    const session = await tenantB.api.getSession({
      headers: replayOnTenant(tokenOnly, 'tenant-a', 'tenant-b'),
    });

    expect(session).toBeNull();
  });
});

describe('tenant auth token endpoints', () => {
  // These endpoints call a provider's token URL (tenant-chosen for tenant SSO)
  // with better-auth's own fetch, outside the SSRF-safe transport.
  it.each(['/get-access-token', '/refresh-token'])('does not serve %s', async (path) => {
    const auth = await tenantAuth('tenant-token');
    const signUp = await auth.api.signUpEmail({
      asResponse: true,
      body: {
        email: `bob${path.replaceAll('/', '.')}@example.com`,
        name: 'Bob',
        password: 'correct-horse-battery',
      },
    });

    const response = await auth.handler(
      new Request(`http://localhost:3010/t/tenant-token/api/auth${path}`, {
        body: JSON.stringify({ providerId: 'acme-oidc' }),
        headers: { 'content-type': 'application/json', 'cookie': cookieHeaderOf(signUp) },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(404);
  });
});
