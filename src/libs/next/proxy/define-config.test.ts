/**
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';

import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config as proxyConfig } from '@/proxy';
import { TENANT_ROUTE_HEADER, verifyTenantRoute } from '@/server/modules/Tenant/routeHeader';
import { TenantRoutingUnavailableError } from '@/server/modules/Tenant/routingErrors';

import { defineConfig } from './define-config';
import {
  handleNavigationRedirect,
  NAVIGATION_REDIRECT_HEADER,
  NAVIGATION_REDIRECT_PATH,
} from './navigationRedirect';

// Next's node server installs this global before it loads any proxy code; the adapter's
// work-store module captures it once at first import, so it must exist before any import.
vi.hoisted(() => {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??=
    require('node:async_hooks').AsyncLocalStorage;
});

const mocks = vi.hoisted(() => ({
  enterSlug: vi.fn(),
  findHost: vi.fn(),
  remembered: vi.fn(),
  findSlug: vi.fn(),
  getSession: vi.fn(),
  desktopSelection: vi.fn(),
}));

vi.mock('@/server/modules/Tenant/endpoints', () => ({
  endpointHosts: () => ({ appUrl: 'http://localhost:3010', internalUrl: 'http://internal:3210' }),
  findHostEndpoint: (host: string) => mocks.findHost(host),
  getTenantEndpoints: () => ({ get: mocks.remembered }),
  findSlugEndpoint: (slug: string) => mocks.findSlug(slug),
}));
vi.mock('@/server/services/tenantDiscovery/desktop', () => ({
  selectDesktopTenant: mocks.desktopSelection,
}));
vi.mock('@/auth', () => ({
  getTenantAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({ enterSlug: mocks.enterSlug }),
}));

process.env.KEY_VAULTS_SECRET = 'proxy-test-master-secret';

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.desktopSelection
    .mockReset()
    .mockResolvedValue({ url: 'https://chat.example.com/oidc/auth?state=authorized' });
  mocks.findHost.mockReset().mockResolvedValue(null);
  mocks.remembered
    .mockReset()
    .mockResolvedValue({ activeUrl: 'http://localhost:3010/t/acme', appliedVersion: 1 });
  mocks.findSlug.mockReset().mockImplementation(async (slug: string) =>
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
  );
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

/**
 * Next rebuilds every middleware `Location` through URL objects that drop an empty fragment, so
 * the proxy hands these redirects to a route handler instead. Follow that hand-off the way Next
 * does (internal rewrite carrying the overridden request header) and return the final response.
 */
const followNavigationRedirect = (proxied: Response) => {
  const rewrite = new URL(proxied.headers.get('x-middleware-rewrite')!);
  expect(rewrite.pathname).toBe(NAVIGATION_REDIRECT_PATH);
  expect(proxied.headers.get('location')).toBeNull();
  return handleNavigationRedirect(
    new Request(rewrite, {
      headers: {
        [NAVIGATION_REDIRECT_HEADER]: proxied.headers.get(
          `x-middleware-request-${NAVIGATION_REDIRECT_HEADER}`,
        )!,
      },
    }),
  );
};
const expectFragmentRedirect = (proxied: Response, location: string) => {
  const final = followNavigationRedirect(proxied);
  expect(final.status).toBe(302);
  expect(final.headers.get('location')).toBe(location);
  expect(location.endsWith('#')).toBe(true);
};

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
  it('rejects unqualified pages without a tenant', async () => {
    const response = await middleware(new NextRequest('http://localhost:3010/settings?hl=en-US'));
    expect(response.status).toBe(404);
  });

  it('serves the same page for an unknown tenant, without revealing that it does not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await middleware(
        new NextRequest('http://localhost:3010/t/nope/settings?hl=en-US'),
      );
      expect(response.status).toBe(404);
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
      expect(JSON.stringify(unknown)).not.toContain('nope');
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
    const response = await middleware(new NextRequest(`http://localhost:3010${path}`));
    expect(response.status).toBe(404);
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

const documentNavigation = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new NextRequest(`http://localhost:3010${path}`, {
    method,
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers },
  });

describe('document-only tenant navigation memory', () => {
  it.each(['/t/acme/signin', '/t/acme/share/t/public', '/t/acme/settings'])(
    'records the explicit tenant for %s, including auth and public early returns',
    async (path) => {
      mocks.getSession.mockResolvedValue({ headers: new Headers(), response: null });
      const response = await middleware(documentNavigation(path));
      expect(response.headers.getSetCookie()).toContain(
        'lobe-last-tenant=tenant-1; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax',
      );
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    },
  );
  it('records a valid explicit tenant before cross-domain redirect or endpoint-changed', async () => {
    mocks.findSlug.mockResolvedValue({
      slug: 'acme',
      tenantId: 'tenant-1',
      state: {
        activeUrl: 'https://chat.example.com',
        endpoints: [{ kind: 'default', host: null, active: false }],
      },
    });
    for (const path of ['/t/acme/agent', '/t/acme/signin?email=private@example.com']) {
      const response = await middleware(documentNavigation(path));
      expect([302, 409]).toContain(response.status);
      expect(response.headers.getSetCookie().join()).toContain('lobe-last-tenant=tenant-1;');
    }
  });
  it('marks an unchanged preference private without renewing the cookie', async () => {
    const response = await middleware(
      documentNavigation('/t/acme/signin', { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each([{ purpose: 'prefetch' }, { 'sec-purpose': 'prefetch;prerender' }])(
    'does not write or consume speculative request memory: %j',
    async (headers) => {
      const response = await middleware(documentNavigation('/t/acme/signin', headers));
      expect(response.headers.getSetCookie()).toEqual([]);
      const root = await middleware(
        documentNavigation('/', { ...headers, cookie: 'lobe-last-tenant=tenant-1' }),
      );
      expect(root.headers.get('location')).toBeNull();
      expect(new URL(root.headers.get('x-middleware-rewrite')!).pathname).toBe('/spa-auth/en-US/');
      expect(mocks.remembered).not.toHaveBeenCalled();
    },
  );
  it('does not infer a tenant for unqualified GET, HEAD, backend or protocol requests', async () => {
    for (const request of [
      new NextRequest('http://localhost:3010/agent', {
        headers: { cookie: 'lobe-last-tenant=tenant-1' },
      }),
      documentNavigation('/agent', { cookie: 'lobe-last-tenant=tenant-1' }, 'HEAD'),
      documentNavigation('/api/auth/callback/google?code=x'),
      documentNavigation('/oauth/connector/callback?code=x'),
    ]) {
      const response = await middleware(request);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it.each([
    '/t/nope/settings?token=secret',
    '/t/INVALID/signin?code=secret',
    '/signin?email=private@example.com',
    '/oauth/consent/code?state=secret',
    '/verify-email?token=secret',
    '/verify/id',
    '/acceptance/id',
    '/share/t/id',
    '/verify-im',
  ])('discards sensitive navigation context for %s without consuming memory', async (path) => {
    const response = await middleware(
      documentNavigation(path, { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it('sends an ordinary deep link through the root and drops its path, query and fragment', async () => {
    const response = await middleware(
      documentNavigation('/agent/private?topic=secret#token', {
        cookie: 'lobe-last-tenant=tenant-1',
      }),
    );
    expectFragmentRedirect(response, 'http://localhost:3010/#');
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it('reads the remembered tenant id live and redirects to its current endpoint root', async () => {
    mocks.remembered.mockResolvedValue({
      activeUrl: 'https://chat.example.com',
      appliedVersion: 1,
    });
    const response = await middleware(
      documentNavigation('/?other=secret', { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expectFragmentRedirect(response, 'https://chat.example.com/#');
    expect(mocks.remembered).toHaveBeenCalledWith('tenant-1');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('renders discovery for a missing preference, switch=1 and unqualified root GET', async () => {
    for (const request of [
      documentNavigation('/'),
      documentNavigation('/?switch=1', { cookie: 'lobe-last-tenant=tenant-1' }),
      new NextRequest('http://localhost:3010/'),
    ]) {
      const response = await middleware(request);
      expect(new URL(response.headers.get('x-middleware-rewrite')!).pathname).toBe(
        '/spa-auth/en-US/',
      );
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it('clears a vanished tenant but preserves the preference on a temporary failure', async () => {
    mocks.remembered.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'TENANT_NOT_FOUND' }),
    );
    const vanished = await middleware(
      documentNavigation('/', { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expect(vanished.headers.get('x-middleware-rewrite')).toContain('/spa-auth/en-US/');
    expect(vanished.headers.getSetCookie().join()).toContain('Max-Age=0');
    mocks.remembered.mockRejectedValueOnce(new Error('database unavailable'));
    const unavailable = await middleware(
      documentNavigation('/', { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.getSetCookie()).toEqual([]);
    expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
  });
  it('does not let a remembered tenant affect a custom host or machine request', async () => {
    mocks.findHost.mockResolvedValue({
      slug: 'acme',
      tenantId: 'tenant-1',
      state: {
        activeUrl: 'https://chat.example.com',
        endpoints: [{ kind: 'custom', host: 'chat.example.com', active: true }],
      },
    });
    const custom = await middleware(
      new NextRequest('https://chat.example.com/signin', {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }),
    );
    expect(custom.headers.getSetCookie()).toEqual([]);
    const api = await middleware(documentNavigation('/t/acme/api/auth/get-session'));
    expect(api.headers.getSetCookie()).toEqual([]);
  });
});

describe('navigation failure and protocol boundaries', () => {
  it('uses the normal synthesized default endpoint for ordinary remembered navigation', async () => {
    mocks.remembered.mockResolvedValueOnce({
      activeUrl: 'http://localhost:3010/t/acme',
      appliedVersion: 0,
    });
    const response = await middleware(
      documentNavigation('/', { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expectFragmentRedirect(response, 'http://localhost:3010/t/acme/#');
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('clears malformed memory without accessing the directory', async () => {
    const response = await middleware(
      documentNavigation('/', { cookie: 'lobe-last-tenant=bad/value' }),
    );
    expect(response.headers.getSetCookie().join()).toContain('Max-Age=0');
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it.each(['HEAD', 'POST', 'PUT'])(
    'rejects a tenantless %s page without reading or writing memory',
    async (method) => {
      for (const path of method === 'HEAD'
        ? ['/signin', '/agent', '/t/nope/settings']
        : ['/', '/signin', '/agent', '/t/nope/settings']) {
        const response = await middleware(
          documentNavigation(path, { cookie: 'lobe-last-tenant=tenant-1' }, method),
        );
        expect(response.status).toBe(404);
        expect(response.headers.getSetCookie()).toEqual([]);
      }
      expect(mocks.remembered).not.toHaveBeenCalled();
    },
  );
  it('does not write memory for explicit page HEAD or fetch GET', async () => {
    for (const request of [
      documentNavigation('/t/acme/signin', {}, 'HEAD'),
      new NextRequest('http://localhost:3010/t/acme/signin'),
    ])
      expect((await middleware(request)).headers.getSetCookie()).toEqual([]);
  });
  it('uses a safe locale in the root discovery rewrite', async () => {
    const response = await middleware(documentNavigation('/?hl=../../api/dev'));
    expect(new URL(response.headers.get('x-middleware-rewrite')!).pathname).toBe(
      '/spa-auth/en-US/',
    );
  });
});

const desktopState = 'a'.repeat(32);
const desktopChallenge = 'B'.repeat(43);
const desktopPath = `/?client=desktop&state=${desktopState}&code_challenge=${desktopChallenge}`;
const desktopMarker = 'x-lobe-desktop-flow';
const desktopStatusOf = (response: Response) =>
  response.headers.get(`x-middleware-request-${desktopMarker}`);

describe('dedicated desktop document navigation', () => {
  it('creates a selection through the shared protected service before ordinary remembered routing', async () => {
    const response = await middleware(
      documentNavigation(desktopPath, {
        'cookie': 'lobe-last-tenant=tenant-1',
        'x-real-ip': '192.0.2.1',
      }),
    );
    expectFragmentRedirect(response, 'https://chat.example.com/oidc/auth?state=authorized#');
    expect(mocks.desktopSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        flow: { state: desktopState, codeChallenge: desktopChallenge },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mocks.remembered).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it.each([
    '/?client=desktop',
    '/?client=desktop&state=bad&code_challenge=bad',
    `${desktopPath}&state=${desktopState}`,
    `${desktopPath}&code_challenge=${desktopChallenge}`,
    `/?client=web&client=desktop&state=${desktopState}&code_challenge=${desktopChallenge}`,
  ])('does not consume memory for invalid desktop parameters: %s', async (path) => {
    const response = await middleware(
      documentNavigation(path, { cookie: 'lobe-last-tenant=tenant-1', [desktopMarker]: 'ready' }),
    );
    expect(desktopStatusOf(response)).toBe('invalid');
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.desktopSelection).not.toHaveBeenCalled();
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it.each([desktopPath, `${desktopPath}&switch=1`])(
    'renders the desktop choice page without consumption when there is no memory or switching: %s',
    async (path) => {
      const response = await middleware(
        documentNavigation(
          path,
          path.includes('switch=1') ? { cookie: 'lobe-last-tenant=tenant-1' } : {},
        ),
      );
      expect(desktopStatusOf(response)).toBe('ready');
      expect(response.headers.get('location')).toBeNull();
      expect(new URL(response.headers.get('x-middleware-rewrite')!).search).toBe('');
      expect(mocks.desktopSelection).not.toHaveBeenCalled();
      expect(mocks.remembered).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['TENANT_NOT_AVAILABLE', 'ready'],
    ['HANDOFF_EXISTS', 'expired'],
    ['RATE_LIMITED', 'unavailable'],
    ['TENANT_DISCOVERY_UNAVAILABLE', 'unavailable'],
  ])('renders the correct desktop status for %s', async (code, status) => {
    mocks.desktopSelection.mockRejectedValueOnce(
      Object.assign(new Error('private-state must not be logged'), { code }),
    );
    const response = await middleware(
      documentNavigation(desktopPath, { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expect(desktopStatusOf(response)).toBe(status);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it('does not consume memory or create a snapshot for speculative or non-document requests', async () => {
    for (const headers of [
      { purpose: 'prefetch' },
      { 'sec-purpose': 'prefetch' },
      { 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-dest': 'empty' },
    ]) {
      const response = await middleware(
        documentNavigation(desktopPath, {
          ...headers,
          cookie: 'lobe-last-tenant=tenant-1',
          [desktopMarker]: 'ready',
        }),
      );
      expect(desktopStatusOf(response)).toBeNull();
      expect(response.headers.get('location')).toBeNull();
    }
    expect((await middleware(documentNavigation(desktopPath, {}, 'POST'))).status).toBe(404);
    const head = await middleware(
      documentNavigation(desktopPath, { cookie: 'lobe-last-tenant=tenant-1' }, 'HEAD'),
    );
    expect(head.status).toBe(200);
    expect(desktopStatusOf(head)).toBeNull();
    expect(mocks.desktopSelection).not.toHaveBeenCalled();
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it('keeps explicit tenant and custom host roots outside desktop discovery', async () => {
    const explicit = await middleware(
      documentNavigation(`/t/acme${desktopPath}`, {
        cookie: 'lobe-last-tenant=other',
        [desktopMarker]: 'expired',
      }),
    );
    expect(desktopStatusOf(explicit)).toBeNull();
    mocks.findHost.mockResolvedValue({
      slug: 'acme',
      tenantId: 'tenant-1',
      state: {
        activeUrl: 'https://chat.example.com',
        endpoints: [{ kind: 'custom', host: 'chat.example.com', active: true }],
      },
    });
    const custom = await middleware(
      new NextRequest(`https://chat.example.com${desktopPath}`, {
        headers: {
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          [desktopMarker]: 'expired',
        },
      }),
    );
    expect(desktopStatusOf(custom)).toBeNull();
    expect(mocks.desktopSelection).not.toHaveBeenCalled();
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it('strips a client marker from ordinary roots, auth pages and backend rewrites', async () => {
    for (const path of ['/', '/t/acme/signin', '/api/version', '/t/acme/api/auth/get-session']) {
      const response = await middleware(
        documentNavigation(path, { [desktopMarker]: 'unavailable' }),
      );
      expect(desktopStatusOf(response)).toBeNull();
    }
  });
});

describe('ordinary navigation recovery', () => {
  it('renders an unscoped HEAD root without consuming a remembered tenant', async () => {
    const response = await middleware(
      documentNavigation('/', { cookie: 'lobe-last-tenant=tenant-1' }, 'HEAD'),
    );
    expect(new URL(response.headers.get('x-middleware-rewrite')!).pathname).toBe(
      '/spa-auth/en-US/',
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mocks.remembered).not.toHaveBeenCalled();
    expect(mocks.desktopSelection).not.toHaveBeenCalled();
  });
  it('does not persist a tenant that disappeared between routing and admission', async () => {
    mocks.enterSlug.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'TENANT_NOT_FOUND' }),
    );
    const response = await middleware(documentNavigation('/t/acme/agent'));
    expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('shows a localized retry page during a remembered-directory outage and preserves the cookie', async () => {
    mocks.remembered.mockRejectedValueOnce(new Error('private-state'));
    const response = await middleware(
      documentNavigation('/?hl=zh-CN', { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.getSetCookie()).toEqual([]);
    const html = await response.text();
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('重试');
    expect(html).not.toContain('private-state');
  });
});

it('preserves routed headers when a tenant page reaches the local dev proxy bypass', async () => {
  const response = await middleware(
    new NextRequest('http://localhost:3010/t/acme/_dangerous_local_dev_proxy'),
  );
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(
    verifyTenantRoute(response.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`)),
  ).toBe('acme');
});

describe('fragment-clearing redirect hand-off', () => {
  it('drops a client-supplied hand-off value before the request reaches any route', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/api/internal/navigation-redirect', {
        headers: { [NAVIGATION_REDIRECT_HEADER]: 'forged.value' },
      }),
    );
    expect(response.headers.get(`x-middleware-request-${NAVIGATION_REDIRECT_HEADER}`)).toBeNull();
    expect(response.headers.get('x-middleware-override-headers') ?? '').not.toContain(
      NAVIGATION_REDIRECT_HEADER,
    );
  });

  it('survives Next’s proxy adapter, which rebuilds any middleware Location without its `#`', async () => {
    const { adapter } = await import('next/dist/server/web/adapter');
    const { response } = await adapter({
      handler: (request: NextRequest) => middleware(request),
      page: '/proxy',
      request: {
        headers: {
          'host': 'localhost:3010',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
        },
        method: 'GET',
        nextConfig: {},
        url: 'http://localhost:3010/signin?email=private@example.com',
      },
    } as never);
    expect(response.headers.get('location')).toBeNull();
    expect(followNavigationRedirect(response).headers.get('location')).toBe(
      'http://localhost:3010/?switch=1#',
    );
  });
});
