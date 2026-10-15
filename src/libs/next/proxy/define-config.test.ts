/**
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';

import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { config as proxyConfig } from '@/proxy';
import { TENANT_ROUTE_HEADER, verifyTenantRoute } from '@/server/modules/Tenant/routeHeader';
import { TenantRoutingUnavailableError } from '@/server/modules/Tenant/routingErrors';

import { defineConfig } from './define-config';

const mocks = vi.hoisted(() => ({
  enterSlug: vi.fn(),
  findHost: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/server/modules/Tenant/endpoints', () => ({
  endpointHosts: () => ({ appUrl: 'http://localhost:3010', internalUrl: 'http://internal:3210' }),
  findHostEndpoint: (host: string) => mocks.findHost(host),
  findSlugEndpoint: async (slug: string) =>
    slug === 'acme'
      ? {
          slug,
          tenantId: 'tenant-1',
          state: {
            activeUrl: 'http://localhost:3010/t/acme',
            endpoints: [{ kind: 'default', host: null, active: true }],
          },
        }
      : null,
}));
vi.mock('@/auth', () => ({
  getTenantAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({ enterSlug: mocks.enterSlug }),
}));

process.env.KEY_VAULTS_SECRET = 'proxy-test-master-secret';

beforeEach(() => {
  mocks.findHost.mockReset().mockResolvedValue(null);
  // Better Auth changes the result shape when returnHeaders is true.
  mocks.getSession
    .mockReset()
    .mockResolvedValue({ headers: new Headers(), response: { user: { id: 'user-1' } } });
  mocks.enterSlug.mockReset().mockImplementation(async (slug: string) => {
    if (slug === 'acme')
      return {
        release: async () => {},
        scope: {
          slug,
          tenantId: 'tenant-1',
          endpoint: { basePath: '/t/acme', publicUrl: 'http://localhost:3010/t/acme', version: 1 },
        },
      };
    throw Object.assign(new Error('not found'), { code: 'TENANT_NOT_FOUND' });
  });
});

it.each([
  [null, 'TENANT_UNAVAILABLE'],
  [undefined, 'TENANT_UNAVAILABLE'],
  [new Error('database unavailable'), 'TENANT_UNAVAILABLE'],
  [
    Object.assign(new Error('damaged projection'), { code: 'ENDPOINTS_NOT_READY' }),
    'ENDPOINTS_NOT_READY',
  ],
])('reports endpoint lookup failure without admitting a fallback tenant', async (error, code) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mocks.findHost.mockRejectedValueOnce(error);
    const response = await defineConfig().middleware(
      new NextRequest('https://chat.example.com/agent'),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code });
    expect(mocks.enterSlug).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([['TENANT_ROUTING_UNAVAILABLE', { reason: 'UNKNOWN' }]]);
  } finally {
    warn.mockRestore();
  }
});

it.each([
  [new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED'), 'ROUTING_LOAD_EXPIRED'],
  [
    Object.assign(new Error('postgres://synthetic-secret@private.invalid/db'), {
      reason: 'ROUTING_ABORTED',
      code: 'malicious SQL SELECT synthetic-secret',
    }),
    'UNKNOWN',
  ],
  [
    Object.assign(new TenantRoutingUnavailableError('ROUTING_ABORTED'), {
      reason: 'postgres://synthetic-secret@private.invalid/db',
    }),
    'UNKNOWN',
  ],
])('logs only a closed routing reason for lookup failures', async (error, reason) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mocks.findHost.mockRejectedValueOnce(error);
    const response = await defineConfig().middleware(
      new NextRequest('https://chat.example.com/agent'),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'TENANT_UNAVAILABLE' });
    expect(warn.mock.calls).toEqual([['TENANT_ROUTING_UNAVAILABLE', { reason }]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret');
  } finally {
    warn.mockRestore();
  }
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rewrite = await run('http://localhost:3010/t/nope/settings?hl=en-US');
      expect(new URL(rewrite!).pathname).toBe('/tenant-required');
      expect(mocks.getSession).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

describe('unknown tenant is indistinguishable from no tenant (FR-RT-06)', () => {
  const origin = 'http://localhost:3010';

  /** Everything a client can observe, with a rewrite/next folded into the path it serves. */
  const observe = async (path: string, method: string) => {
    const response = (await middleware(new NextRequest(`${origin}${path}`, { method })))!;
    const rewrite = response.headers.get('x-middleware-rewrite');
    const target = rewrite
      ? `${new URL(rewrite).pathname}${new URL(rewrite).search}`
      : response.headers.get('x-middleware-next')
        ? path
        : null;
    return {
      body: response.body ? await response.text() : '',
      cacheControl: response.headers.get('cache-control'),
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'),
      status: response.status,
      target,
      tenantHeader: response.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`),
    };
  };

  const cases: [string, string][] = [
    ['GET', '/settings?hl=en-US'],
    ['GET', '/webapi/user/avatar/x/y.webp'],
    ['POST', '/webapi/chat/openai'],
    ['GET', '/trpc/lambda/config.getGlobalConfig?batch=1'],
    ['POST', '/trpc/lambda/message.createMessage?batch=1'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-in/email'],
    ['GET', '/oidc/auth'],
    ['POST', '/oidc/token'],
    ['GET', '/oauth/connector/callback?code=x'],
    ['GET', '/f/file-id'],
    ['PUT', '/f/file-id'],
    ['GET', '/market/api/x'],
    ['DELETE', '/api/agent/run'],
    ['GET', '/api/version'],
  ];

  it.each(cases)('%s %s answers exactly as it does without a tenant', async (method, path) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const withoutTenant = await observe(path, method);
      const unknown = await observe(`/t/nope${path}`, method);
      expect(unknown).toEqual(withoutTenant);
      expect(JSON.stringify(unknown)).not.toMatch(/NOT_FOUND|nope/);
      expect(unknown.tenantHeader).toBeNull();
      expect(mocks.getSession).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses unknown-tenant API requests with TENANT_REQUIRED', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await middleware(
        new NextRequest(`${origin}/t/nope/trpc/lambda/config.getGlobalConfig`),
      );
      expect(response?.status).toBe(400);
      await expect(response!.json()).resolves.toEqual({ code: 'TENANT_REQUIRED' });
    } finally {
      warn.mockRestore();
    }
  });

  it('records the real reason on the server only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await middleware(new NextRequest(`${origin}/t/nope/api/auth/get-session`));
      expect(warn).toHaveBeenCalledWith('TENANT_NOT_FOUND', { slug: 'nope' });
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the root-only surfaces closed under any tenant prefix, known or not', async () => {
    for (const slug of ['acme', 'nope'])
      expect(
        (
          await middleware(
            new NextRequest(`${origin}/t/${slug}/api/internal/control-plane/v1/tenants/x`),
          )
        )?.status,
      ).toBe(404);
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

describe('project deep links', () => {
  const paths = ['/projects', '/project/environment-demo', '/project/environment-demo/tasks'];

  it.each(paths)('routes tenant %s into the SPA on a direct request', async (path) => {
    const request = new NextRequest(`http://localhost:3010/t/acme${path}`);
    expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url: request.url })).toBe(true);
    const response = await middleware(request);
    const rewrite = response!.headers.get('x-middleware-rewrite')!;
    expect(new URL(rewrite).pathname).toMatch(new RegExp(`/spa/[^/]+${path}$`));
    expect(mocks.enterSlug).toHaveBeenCalledWith('acme');
  });

  it.each(paths)('requires a tenant for an unscoped %s request', async (path) => {
    const rewrite = await run(`http://localhost:3010${path}`);
    expect(new URL(rewrite!).pathname).toBe('/tenant-required');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});

describe('actual Host authority', () => {
  const custom = {
    slug: 'acme',
    tenantId: 'tenant-1',
    state: {
      activeUrl: 'https://chat.example.com',
      endpoints: [
        { kind: 'default', host: null, active: false },
        { kind: 'custom', host: 'chat.example.com', active: true },
      ],
    },
  };
  it('clears the deployment URL port for a custom authority without a port', async () => {
    mocks.findHost.mockResolvedValue(custom);
    const response = await middleware(
      new NextRequest('http://localhost:3392/api/auth/get-session', {
        headers: { 'host': 'chat.example.com', 'x-forwarded-host': 'evil.example.com' },
      }),
    );
    expect(response?.headers.get('x-middleware-rewrite')).not.toBeNull();
    expect(
      verifyTenantRoute(response?.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`)),
    ).toBe('acme');
    expect(mocks.findHost).toHaveBeenCalledWith('chat.example.com');
  });
  it('uses an explicit configured default port instead of the deployment URL port', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3392/t/acme/api/auth/get-session', {
        headers: { 'host': 'localhost:3010', 'x-forwarded-host': 'evil.example.com' },
      }),
    );
    expect(response?.headers.get('x-middleware-rewrite')).not.toBeNull();
    expect(
      verifyTenantRoute(response?.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`)),
    ).toBe('acme');
    expect(mocks.findHost).not.toHaveBeenCalled();
  });
  it.each([
    'localhost:invalid',
    'localhost:99999',
    'localhost:',
    'user@localhost:3010',
    'localhost:3010/path',
    'localhost:3010?x=1',
    'localhost:3010#x',
    'localhost:3010\\x',
    'localhost::3010',
  ])('refuses malformed authority %s without falling back to the URL host', async (host) => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/t/acme/api/auth/get-session', { headers: { host } }),
    );
    expect(response?.status).toBe(404);
    await expect(response!.json()).resolves.toEqual({ code: 'NOT_FOUND' });
    expect(mocks.findHost).not.toHaveBeenCalled();
    expect(mocks.enterSlug).not.toHaveBeenCalled();
  });
});
