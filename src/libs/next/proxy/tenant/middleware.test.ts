/**
 * @vitest-environment node
 */
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import {
  NAVIGATION_REDIRECT_HEADER,
  NAVIGATION_REDIRECT_PATH,
} from '@/libs/next/proxy/navigationRedirect';
import { config as proxyConfig } from '@/proxy';
import { TENANT_ROUTE_HEADER, verifyTenantRoute } from '@/server/modules/Tenant/routeHeader';
import { TenantRoutingUnavailableError } from '@/server/modules/Tenant/routingErrors';
import { RouteVariants } from '@/utils/server/routeVariants';

import { defineConfig } from '../define-config';
import { resolveTenantlessRoute } from '../tenantRouting';
import { mocks, useTenantMocks } from './testKit';

// Next's node server installs this global before it loads any proxy code; the adapter's
// work-store module captures it once at first import, so it must exist before any import.
vi.hoisted(() => {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??=
    require('node:async_hooks').AsyncLocalStorage;
});

vi.mock('@/server/modules/Tenant/endpoints', async () =>
  (await import('./testKit')).endpointsModule(),
);
vi.mock('@/server/services/tenantDiscovery/desktop', async () =>
  (await import('./testKit')).desktopModule(),
);
vi.mock('@/server/services/tenantDiscovery/account', async () =>
  (await import('./testKit')).accountModule(),
);
vi.mock('@/auth', async () => (await import('./testKit')).authModule());
vi.mock('@/server/modules/Tenant/runtime', async () => (await import('./testKit')).runtimeModule());

useTenantMocks();

const { middleware } = defineConfig();

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

describe('tenant routing', () => {
  it('rejects unqualified pages without a tenant', async () => {
    const response = await middleware(new NextRequest('http://localhost:3010/settings?hl=en-US'));
    expect(response.status).toBe(404);
  });

  it('serves the same page for an unknown tenant, without revealing that it does not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await middleware(
        new NextRequest('http://localhost:3010/orgs/nope/settings?hl=en-US'),
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
      new NextRequest('http://localhost:3010/orgs/acme/trpc/lambda/x?batch=1', {
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
      new NextRequest('http://localhost:3010/orgs/acme/api/internal/control-plane/v1/tenants/x'),
    );
    expect(response?.status).toBe(404);
  });

  it('keeps the landing tenant lookup reachable without a tenant', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/api/internal/tenant-discovery/lookup', {
        method: 'POST',
      }),
    );
    expect(response?.headers.get('x-middleware-next')).toBe('1');
  });

  it('refuses the landing tenant lookup under a tenant prefix', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/orgs/acme/api/internal/tenant-discovery/lookup', {
        method: 'POST',
      }),
    );
    expect(response?.status).toBe(404);
  });

  it.each([
    ['/api/internal/tenant-discovery/lookup', { kind: 'tenantless-backend' }],
    ['/api/internal/tenant-discovery/lookup/', { kind: 'tenantless-backend' }],
    ['/api/internal/tenant-discovery', { code: 'TENANT_REQUIRED', kind: 'reject', status: 400 }],
    ['/api/internal/tenant-discovery/', { code: 'TENANT_REQUIRED', kind: 'reject', status: 400 }],
    [
      '/api/internal/tenant-discovery/other',
      { code: 'TENANT_REQUIRED', kind: 'reject', status: 400 },
    ],
    [
      '/api/internal/tenant-discovery/lookup/extra',
      { code: 'TENANT_REQUIRED', kind: 'reject', status: 400 },
    ],
    [
      '/api/internal/tenant-discovery/lookups',
      { code: 'TENANT_REQUIRED', kind: 'reject', status: 400 },
    ],
  ])('resolves tenantless %s exactly', (pathname, expected) => {
    expect(resolveTenantlessRoute(pathname)).toEqual(expected);
  });

  it('keeps the deployment-wide schedules reachable without a tenant', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/api/cron/goal-sweep', { method: 'POST' }),
    );
    expect(response?.headers.get('x-middleware-next')).toBe('1');
  });

  it('refuses the schedules under a tenant prefix', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/orgs/acme/api/cron/goal-sweep', { method: 'POST' }),
    );
    expect(response?.status).toBe(404);
  });

  it('routes a tenant workflow callback to the tenant', async () => {
    const response = await middleware(
      new NextRequest('http://internal:3210/orgs/acme/api/workflows/goal/advance', {
        method: 'POST',
      }),
    );
    const rewrite = new URL(response!.headers.get('x-middleware-rewrite')!);
    expect(rewrite.pathname).toBe('/api/workflows/goal/advance');
    const forwarded = response!.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`);
    expect(verifyTenantRoute(forwarded)).toBe('acme');
  });

  it('redirects a signed-out visitor to the tenant sign-in page', async () => {
    mocks.getSession.mockResolvedValue({ headers: new Headers(), response: null });
    const response = await middleware(new NextRequest('http://localhost:3010/orgs/acme/settings'));

    const location = new URL(response!.headers.get('location')!);
    expect(location.pathname).toBe('/orgs/acme/signin');
    expect(location.searchParams.get('callbackUrl')).toContain('/orgs/acme/settings');
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
      const unknown = await observe(`/orgs/nope${path}`, method);
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
        new NextRequest(`${origin}/orgs/nope/trpc/lambda/config.getGlobalConfig`),
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
      await middleware(new NextRequest(`${origin}/orgs/nope/api/auth/get-session`));
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
            new NextRequest(`${origin}/orgs/${slug}/api/internal/control-plane/v1/tenants/x`),
          )
        )?.status,
      ).toBe(404);
  });
});

describe('session cookies and OIDC endpoints under a tenant', () => {
  it('clears revoked authorization cookies on the protected-page redirect', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'lh_x.session_token=; Max-Age=0; Path=/orgs/acme; HttpOnly');
    headers.append('set-cookie', 'lh_x.session_data.0=; Max-Age=0; Path=/orgs/acme; HttpOnly');
    mocks.getSession.mockResolvedValueOnce({ headers, response: null });

    const response = await middleware(new NextRequest('http://localhost:3010/orgs/acme/settings'));

    expect(response?.status).toBe(302);
    expect(new URL(response!.headers.get('location')!).pathname).toBe('/orgs/acme/signin');
    expect(response?.headers.getSetCookie()).toEqual(headers.getSetCookie());
  });

  it.each([
    '/orgs/acme/oidc/.well-known/openid-configuration',
    '/orgs/acme/oidc/jwks',
    '/orgs/acme/oidc/me',
  ])('serves %s as a tenant backend endpoint without a session lookup', async (path) => {
    const response = await middleware(new NextRequest(`http://localhost:3010${path}`));

    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(response?.headers.get('location')).toBeNull();
    expect(new URL(response!.headers.get('x-middleware-rewrite')!).pathname).toBe(
      path.replace('/orgs/acme', ''),
    );
  });
});

describe('project deep links', () => {
  const paths = ['/projects', '/project/environment-demo', '/project/environment-demo/tasks'];

  it.each(paths)('routes tenant %s into the SPA on a direct request', async (path) => {
    const request = new NextRequest(`http://localhost:3010/orgs/acme${path}`);
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
      new NextRequest('http://localhost:3392/orgs/acme/api/auth/get-session', {
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
      new NextRequest('http://localhost:3010/orgs/acme/api/auth/get-session', {
        headers: { host },
      }),
    );
    expect(response?.status).toBe(404);
    await expect(response!.json()).resolves.toEqual({ code: 'NOT_FOUND' });
    expect(mocks.findHost).not.toHaveBeenCalled();
    expect(mocks.enterSlug).not.toHaveBeenCalled();
  });
});

it('preserves routed headers when a tenant page reaches the local dev proxy bypass', async () => {
  const response = await middleware(
    new NextRequest('http://localhost:3010/orgs/acme/_dangerous_local_dev_proxy'),
  );
  expect(response.headers.get('x-middleware-next')).toBe('1');
  expect(
    verifyTenantRoute(response.headers.get(`x-middleware-request-${TENANT_ROUTE_HEADER}`)),
  ).toBe('acme');
});

describe('scope release on a tenant page', () => {
  const holdScope = () => {
    const release = vi.fn(async () => {});
    mocks.enterSlug.mockResolvedValue({
      release,
      scope: {
        slug: 'acme',
        tenantId: 'tenant-1',
        endpoint: {
          basePath: '/orgs/acme',
          publicUrl: 'http://localhost:3010/orgs/acme',
          version: 1,
        },
      },
    });
    return release;
  };

  it('releases the scope when the page rewrite throws', async () => {
    const release = holdScope();
    vi.spyOn(RouteVariants, 'serializeVariants').mockImplementation(() => {
      throw new Error('rewrite failed');
    });

    await expect(
      middleware(new NextRequest('http://localhost:3010/orgs/acme/agent')),
    ).rejects.toThrow('rewrite failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the scope when the session lookup throws', async () => {
    const release = holdScope();
    mocks.getSession.mockRejectedValue(new Error('session store down'));

    await expect(
      middleware(new NextRequest('http://localhost:3010/orgs/acme/agent')),
    ).rejects.toThrow('session store down');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the scope once on a public page and on a signed-out redirect', async () => {
    const release = holdScope();
    await middleware(new NextRequest('http://localhost:3010/orgs/acme/signin'));
    expect(release).toHaveBeenCalledTimes(1);

    mocks.getSession.mockResolvedValue({ headers: new Headers(), response: null });
    const redirect = await middleware(new NextRequest('http://localhost:3010/orgs/acme/agent'));
    expect(redirect.status).toBe(302);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe('signed navigation redirect transport', () => {
  const document = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };

  it.each(['http://localhost:3010', 'https://chat.example.com'])(
    'refuses direct access to the internal route on %s before any tenant lookup',
    async (origin) => {
      const response = await middleware(
        new NextRequest(`${origin}${NAVIGATION_REDIRECT_PATH}`, {
          headers: { ...document, [NAVIGATION_REDIRECT_HEADER]: 'forged' },
        }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
      expect(mocks.findHost).not.toHaveBeenCalled();
      expect(mocks.findSlug).not.toHaveBeenCalled();
      expect(mocks.remembered).not.toHaveBeenCalled();
    },
  );

  it.each(['/orgs/acme', '/orgs/nope'])(
    'refuses the internal route under the tenant prefix %s',
    async (prefix) => {
      const response = await middleware(
        new NextRequest(`http://localhost:3010${prefix}${NAVIGATION_REDIRECT_PATH}`, {
          headers: { ...document, [NAVIGATION_REDIRECT_HEADER]: 'forged' },
        }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
      expect(mocks.enterSlug).not.toHaveBeenCalled();
    },
  );

  it('drops a client copy of the signed header from every forwarded request', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3010/orgs/acme/api/auth/get-session', {
        headers: { [NAVIGATION_REDIRECT_HEADER]: 'forged' },
      }),
    );
    expect(response.headers.get(`x-middleware-request-${NAVIGATION_REDIRECT_HEADER}`)).toBeNull();
  });
});
