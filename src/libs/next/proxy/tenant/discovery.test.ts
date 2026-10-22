/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { serializeAccountCookie } from '@/server/services/tenantDiscovery/accountCookie';

import { defineConfig } from '../define-config';
import { NAVIGATION_REDIRECT_HEADER } from '../navigationRedirect';
import { documentNavigation, expectFragmentRedirect, mocks, useTenantMocks } from './testKit';

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
    await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it('sends an ordinary deep link through the root and drops its path, query and fragment', async () => {
    const response = await middleware(
      documentNavigation('/agent/private?topic=secret#token', {
        cookie: 'lobe-last-tenant=tenant-1',
      }),
    );
    await expectFragmentRedirect(response, 'http://localhost:3010/#');
    expect(mocks.remembered).not.toHaveBeenCalled();
  });
  it.each(['/signin', '/signin/'])(
    'sends a bare tenantless %s through the root decision instead of the finder page',
    async (path) => {
      const response = await middleware(documentNavigation(path));
      await expectFragmentRedirect(response, 'http://localhost:3010/#');
      expect(mocks.remembered).not.toHaveBeenCalled();
    },
  );
  it.each(['/signin?callbackUrl=%2Ft%2Facme%2Fagent', '/signin/?callbackUrl=%2Ft%2Facme%2Fagent'])(
    'keeps a tenantless %s with any query on the finder page',
    async (path) => {
      const response = await middleware(documentNavigation(path));
      await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
      expect(mocks.remembered).not.toHaveBeenCalled();
    },
  );
  it('reads the remembered tenant id live and redirects to the session entry of its current endpoint', async () => {
    mocks.remembered.mockResolvedValue({
      activeUrl: 'https://chat.example.com',
      appliedVersion: 1,
    });
    const response = await middleware(
      documentNavigation('/?other=secret', { cookie: 'lobe-last-tenant=tenant-1' }),
    );
    await expectFragmentRedirect(response, 'https://chat.example.com/__entry#');
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
    // A platform navigation failure keeps retrying at the root.
    expect(await unavailable.text()).toContain('href="/#"');
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
    await expectFragmentRedirect(response, 'http://localhost:3010/t/acme/__entry#');
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
    await expectFragmentRedirect(response, 'https://chat.example.com/oidc/auth?state=authorized#');
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
    await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
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

describe('fragment-clearing redirect', () => {
  it('replaces a client-supplied signed header instead of trusting it', async () => {
    const response = await middleware(
      documentNavigation('/signin', { [NAVIGATION_REDIRECT_HEADER]: 'forged' }),
    );
    // A bare /signin re-enters the root decision, so the forged header is replaced with /#.
    await expectFragmentRedirect(response, 'http://localhost:3010/#');
    expect(response.headers.get(`x-middleware-request-${NAVIGATION_REDIRECT_HEADER}`)).not.toBe(
      'forged',
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
    await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
  });
});

describe('remembered-account root decision', () => {
  const accountName = 'lobe-last-account';
  const accountCookie = (email = 'user@example.com', tenantId = 'tenant-1', iat?: number) => {
    const line = serializeAccountCookie(email, tenantId, 'http://localhost:3010', iat);
    expect(line).not.toBeNull();
    return line!.split(';')[0];
  };
  const headerOf = (response: Response) =>
    response.headers.get('x-middleware-request-x-lobe-root-account');
  const finderOf = (response: Response) => {
    const rewrite = response.headers.get('x-middleware-rewrite');
    expect(rewrite).not.toBeNull();
    expect(new URL(rewrite!).pathname).toBe('/spa-auth/en-US/');
    expect(headerOf(response)).toBeNull();
  };

  it('renders the root page in account mode for a readable account with two organizations', async () => {
    mocks.accountOrganizations.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
    const response = await middleware(
      documentNavigation('/', { cookie: accountCookie('User@Example.com') }),
    );
    expect(headerOf(response)).toBe('1');
    expect(new URL(response.headers.get('x-middleware-rewrite')!).pathname).toBe(
      '/spa-auth/en-US/',
    );
    expect(mocks.accountOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@example.com',
        headers: expect.any(Headers),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mocks.remembered).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each([0, 1])(
    'keeps today’s path for %i organization(s), including the remembered tenant entry',
    async (count) => {
      mocks.accountOrganizations.mockResolvedValue(
        Array.from({ length: count }, (_, index) => ({ id: `tenant-${index}` })),
      );
      const finder = await middleware(documentNavigation('/', { cookie: accountCookie() }));
      finderOf(finder);

      const entry = await middleware(
        documentNavigation('/', {
          cookie: `${accountCookie()}; lobe-last-tenant=tenant-1`,
        }),
      );
      await expectFragmentRedirect(entry, 'http://localhost:3010/t/acme/__entry#');
      expect(headerOf(entry)).toBeNull();
    },
  );

  it('does not read the account cookie without one, or with switch=1, desktop or a non-document request', async () => {
    for (const request of [
      documentNavigation('/'),
      documentNavigation('/?switch=1', { cookie: accountCookie() }),
      documentNavigation(
        '/?client=desktop&state=' + 'a'.repeat(32) + '&code_challenge=' + 'B'.repeat(43),
        {
          cookie: accountCookie(),
        },
      ),
      new NextRequest('http://localhost:3010/', { headers: { cookie: accountCookie() } }),
    ]) {
      await middleware(request);
    }
    expect(mocks.accountOrganizations).not.toHaveBeenCalled();
  });

  it('clears an unreadable account cookie and keeps today’s path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const finder = await middleware(
        documentNavigation('/', { cookie: `${accountName}=not-a-value` }),
      );
      finderOf(finder);
      expect(finder.headers.getSetCookie()).toEqual([
        'lobe-last-account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      ]);

      const entry = await middleware(
        documentNavigation('/', {
          cookie: `${accountName}=not-a-value; lobe-last-tenant=tenant-1`,
        }),
      );
      await expectFragmentRedirect(entry, 'http://localhost:3010/t/acme/__entry#');
      expect(entry.headers.getSetCookie()).toContain(
        'lobe-last-account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      );
      expect(mocks.accountOrganizations).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([{ code: 'RATE_LIMITED' }, { code: 'TENANT_DISCOVERY_UNAVAILABLE' }, {}])(
    'falls back to today’s path and logs only a reason code for %o',
    async (failure) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mocks.accountOrganizations.mockRejectedValueOnce(
          Object.assign(new Error('private@example.com'), failure),
        );
        const response = await middleware(
          documentNavigation('/', {
            cookie: `${accountCookie('private@example.com')}; lobe-last-tenant=tenant-1`,
          }),
        );
        await expectFragmentRedirect(response, 'http://localhost:3010/t/acme/__entry#');
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain('TENANT_ACCOUNT_MEMORY_UNAVAILABLE');
        expect(logged).not.toContain('private@example.com');
        expect(logged).toContain(failure.code ?? 'UNKNOWN');
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('strips a client-supplied account-mode header on every proxy path', async () => {
    for (const path of ['/', '/t/acme/signin', '/api/version', '/t/acme/api/auth/get-session']) {
      const response = await middleware(documentNavigation(path, { 'x-lobe-root-account': '1' }));
      expect(headerOf(response)).toBeNull();
      expect(response.headers.get('x-middleware-request-x-lobe-root-account')).toBeNull();
    }
  });
});
