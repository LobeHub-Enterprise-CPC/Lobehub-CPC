/**
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TENANT_ROUTE_HEADER, verifyTenantRoute } from '@/server/modules/Tenant/routeHeader';

import { defineConfig } from './define-config';

const mocks = vi.hoisted(() => ({
  enterSlug: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/auth', () => ({
  getTenantAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({ enterSlug: mocks.enterSlug }),
}));

process.env.KEY_VAULTS_SECRET = 'proxy-test-master-secret';

beforeEach(() => {
  // Better Auth changes the result shape when returnHeaders is true.
  mocks.getSession
    .mockReset()
    .mockResolvedValue({ headers: new Headers(), response: { user: { id: 'user-1' } } });
  mocks.enterSlug.mockReset().mockImplementation(async (slug: string) => {
    if (slug === 'acme') return { release: async () => {}, scope: { slug, tenantId: 'tenant-1' } };
    throw Object.assign(new Error('not found'), { code: 'TENANT_NOT_FOUND' });
  });
});

const { middleware } = defineConfig();

const run = async (url: string, userAgent?: string) => {
  const res = await middleware(
    new NextRequest(url, userAgent ? { headers: { 'user-agent': userAgent } } : undefined),
  );
  return res?.headers.get('x-middleware-rewrite');
};

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

describe('defineConfig locale path-traversal hardening', () => {
  it('rewrites a normal locale into /spa-auth/<locale>', async () => {
    const rewrite = await run('http://localhost:3010/t/acme/signin?hl=ja-JP');
    expect(new URL(rewrite!).pathname).toBe('/spa-auth/ja-JP/signin');
  });

  it('falls back to en-US for a traversal locale (plain)', async () => {
    const rewrite = await run('http://localhost:3010/t/acme/signin?hl=../../api/dev/x');
    const { pathname } = new URL(rewrite!);
    expect(pathname.startsWith('/spa-auth/')).toBe(true);
    expect(pathname).toBe('/spa-auth/en-US/signin');
  });

  it('falls back to en-US for a traversal locale (percent-encoded)', async () => {
    const rewrite = await run('http://localhost:3010/t/acme/signin?hl=..%2F..%2Fapi%2Fdev%2Fx');
    const { pathname } = new URL(rewrite!);
    expect(pathname.startsWith('/spa-auth/')).toBe(true);
    expect(pathname).toBe('/spa-auth/en-US/signin');
  });

  it('does not treat workspace slugs beginning with an auth route as auth SPA pages', async () => {
    const rewrite = await run(
      'http://localhost:3010/t/acme/oauth-preview-e2e-20260716/settings/oauth-apps?hl=en-US',
    );
    expect(new URL(rewrite!).pathname).toMatch(
      /^\/spa\/[^/]+\/oauth-preview-e2e-20260716\/settings\/oauth-apps$/,
    );
  });
});

describe('defineConfig Workbench SPA rewrite', () => {
  it('routes verify through Workbench for every user agent', async () => {
    const mobileVerify = await run(
      'http://localhost:3010/t/acme/verify/run-1?hl=en-US',
      MOBILE_USER_AGENT,
    );
    const desktopVerify = await run('http://localhost:3010/t/acme/verify/run-1?hl=en-US');

    expect(new URL(mobileVerify!).pathname).toBe('/spa-workbench/en-US/verify/run-1');
    expect(new URL(desktopVerify!).pathname).toBe('/spa-workbench/en-US/verify/run-1');
  });

  it('keeps acceptance on the main SPA', async () => {
    const mobileAcceptance = await run(
      'http://localhost:3010/t/acme/acceptance/acceptance-1?hl=en-US',
      MOBILE_USER_AGENT,
    );
    const desktopAcceptance = await run(
      'http://localhost:3010/t/acme/acceptance/acceptance-1?hl=en-US',
    );

    expect(new URL(mobileAcceptance!).pathname).toMatch(/^\/spa\/[^/]+\/acceptance\/acceptance-1$/);
    expect(new URL(desktopAcceptance!).pathname).toMatch(
      /^\/spa\/[^/]+\/acceptance\/acceptance-1$/,
    );
  });

  it('keeps the agent documents index in the Main Mobile SPA', async () => {
    const detail = await run(
      'http://localhost:3010/t/acme/agent/agt_1/docs/doc_1?hl=en-US',
      MOBILE_USER_AGENT,
    );
    const index = await run(
      'http://localhost:3010/t/acme/agent/agt_1/docs?hl=en-US',
      MOBILE_USER_AGENT,
    );

    expect(new URL(detail!).pathname).toBe('/spa-workbench/en-US/agent/agt_1/docs/doc_1');
    expect(new URL(index!).pathname).toMatch(/^\/spa\/[^/]+\/agent\/agt_1\/docs$/);
  });
});

describe('defineConfig Share SPA rewrite', () => {
  it('routes share pages through the Share SPA for every user agent', async () => {
    const mobileTopic = await run(
      'http://localhost:3010/t/acme/share/t/topic-1?hl=en-US',
      MOBILE_USER_AGENT,
    );
    const desktopTopic = await run('http://localhost:3010/t/acme/share/t/topic-1?hl=en-US');
    const desktopPage = await run('http://localhost:3010/t/acme/share/page/docs_1?hl=en-US');
    const desktopArtifact = await run('http://localhost:3010/t/acme/share/artifact/42?hl=en-US');

    expect(new URL(mobileTopic!).pathname).toBe('/spa-share/en-US/share/t/topic-1');
    expect(new URL(desktopTopic!).pathname).toBe('/spa-share/en-US/share/t/topic-1');
    expect(new URL(desktopPage!).pathname).toBe('/spa-share/en-US/share/page/docs_1');
    expect(new URL(desktopArtifact!).pathname).toBe('/spa-share/en-US/share/artifact/42');
  });

  it('leaves non-share paths that merely start with the prefix in the main SPA', async () => {
    const rewrite = await run('http://localhost:3010/t/acme/shared-workspace/settings?hl=en-US');

    expect(new URL(rewrite!).pathname).toMatch(/^\/spa\/[^/]+\/shared-workspace\/settings$/);
  });
});

describe('Acceptance installation guide', () => {
  it('serves the public Markdown asset without authentication or SPA rewrites', async () => {
    const response = await middleware(new NextRequest('http://localhost:3010/acceptance/skill.md'));

    expect(response?.headers.get('x-middleware-next')).toBe('1');
    expect(response?.headers.get('x-middleware-rewrite')).toBeNull();
    expect(response?.headers.get('location')).toBeNull();
    expect(mocks.getSession).not.toHaveBeenCalled();

    const guide = await readFile('public/acceptance/skill.md', 'utf8');
    expect(guide).toContain('npm install -g @lobehub/cli');
    expect(guide).toContain('lh login');
    expect(guide).toContain('lh acceptance install');
    expect(guide).toContain('.agents/skills/acceptance/SKILL.md');
  });
});

describe('tenant routing', () => {
  it('serves the static tenant-required page for pages without a tenant', async () => {
    const rewrite = await run('http://localhost:3010/settings?hl=en-US');
    expect(new URL(rewrite!).pathname).toBe('/tenant-required');
  });

  it('serves the same page for an unknown tenant, without revealing that it does not exist', async () => {
    const rewrite = await run('http://localhost:3010/t/nope/settings?hl=en-US');
    expect(new URL(rewrite!).pathname).toBe('/tenant-required');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('refuses tenantless backend requests with TENANT_REQUIRED', async () => {
    const response = await middleware(new NextRequest('http://localhost:3010/trpc/lambda/x'));
    expect(response?.status).toBe(400);
    await expect(response!.json()).resolves.toEqual({ code: 'TENANT_REQUIRED' });
  });

  it('keeps the control plane reachable without a tenant', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/api/internal/control-plane/v1/tenants/x'),
    );
    expect(response?.headers.get('x-middleware-next')).toBe('1');
  });

  it('rewrites tenant backend requests and replaces any client-sent tenant header', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/t/acme/trpc/lambda/x?batch=1', {
        headers: { [TENANT_ROUTE_HEADER]: 'other.forged' },
      }),
    );

    const rewrite = new URL(response!.headers.get('x-middleware-rewrite')!);
    expect(rewrite.pathname).toBe('/trpc/lambda/x');
    expect(rewrite.search).toBe('?batch=1');
    const forwarded = response!.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`);
    expect(verifyTenantRoute(forwarded)).toBe('acme');
  });

  it('refuses the control plane under a tenant prefix', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/t/acme/api/internal/control-plane/v1/tenants/x'),
    );
    expect(response?.status).toBe(404);
  });

  it('keeps the deployment-wide schedules reachable without a tenant', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/api/cron/goal-sweep', { method: 'POST' }),
    );
    expect(response?.headers.get('x-middleware-next')).toBe('1');
  });

  it('refuses the schedules under a tenant prefix', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/t/acme/api/cron/goal-sweep', { method: 'POST' }),
    );
    expect(response?.status).toBe(404);
  });

  it('routes a tenant workflow callback to the tenant', async () => {
    const response = await middleware(
      new NextRequest('http://internal:3210/t/acme/api/workflows/goal/advance', { method: 'POST' }),
    );
    const rewrite = new URL(response!.headers.get('x-middleware-rewrite')!);
    expect(rewrite.pathname).toBe('/api/workflows/goal/advance');
    const forwarded = response!.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`);
    expect(verifyTenantRoute(forwarded)).toBe('acme');
  });

  it('redirects a signed-out visitor to the tenant sign-in page', async () => {
    mocks.getSession.mockResolvedValue({ headers: new Headers(), response: null });
    const response = await middleware(new NextRequest('http://localhost:3010/t/acme/settings'));

    const location = new URL(response!.headers.get('location')!);
    expect(location.pathname).toBe('/t/acme/signin');
    expect(location.searchParams.get('callbackUrl')).toContain('/t/acme/settings');
  });
});

describe('session cookies and OIDC endpoints under a tenant', () => {
  it('clears revoked authorization cookies on the protected-page redirect', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'lh_x.session_token=; Max-Age=0; Path=/t/acme; HttpOnly');
    headers.append('set-cookie', 'lh_x.session_data.0=; Max-Age=0; Path=/t/acme; HttpOnly');
    mocks.getSession.mockResolvedValueOnce({ headers, response: null });

    const response = await middleware(new NextRequest('http://localhost:3010/t/acme/settings'));

    expect(response?.status).toBe(302);
    expect(new URL(response!.headers.get('location')!).pathname).toBe('/t/acme/signin');
    expect(response?.headers.getSetCookie()).toEqual(headers.getSetCookie());
  });

  it.each([
    '/t/acme/oidc/.well-known/openid-configuration',
    '/t/acme/oidc/jwks',
    '/t/acme/oidc/me',
  ])('serves %s as a tenant backend endpoint without a session lookup', async (path) => {
    const response = await middleware(new NextRequest(`http://localhost:3010${path}`));

    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(response?.headers.get('location')).toBeNull();
    expect(new URL(response!.headers.get('x-middleware-rewrite')!).pathname).toBe(
      path.replace('/t/acme', ''),
    );
  });
});
