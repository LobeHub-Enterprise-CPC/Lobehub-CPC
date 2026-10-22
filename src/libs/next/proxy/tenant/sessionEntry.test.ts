/**
 * @vitest-environment node
 */
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { config as proxyConfig } from '@/proxy';
import { TenantGateError } from '@/server/modules/Tenant/errors';

import { defineConfig } from '../define-config';
import {
  documentNavigation,
  expectFragmentRedirect,
  mocks,
  sessionDataCookie,
  useTenantMocks,
} from './testKit';

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
vi.mock('@/auth', async () => (await import('./testKit')).authModule());
vi.mock('@/server/modules/Tenant/runtime', async () => (await import('./testKit')).runtimeModule());

useTenantMocks();

const { middleware } = defineConfig();

describe('session entry (/__entry)', () => {
  const ACTIVE = 'http://localhost:3010/t/acme';
  const entryUrl = `${ACTIVE}/__entry`;
  const entryPath = '/t/acme/__entry';
  const memoryCookie = (response: Response) =>
    response.headers.getSetCookie().filter((cookie) => cookie.includes('lobe-last-tenant'));
  const releases = () => {
    const release = vi.fn(async () => {});
    mocks.enterSlug.mockImplementation(async (slug: string) => ({
      release,
      scope: {
        slug,
        tenantId: 'tenant-1',
        endpoint: { basePath: '/t/acme', publicUrl: ACTIVE, version: 1 },
      },
    }));
    return release;
  };
  const inactiveDefault = () =>
    mocks.findSlug.mockResolvedValue({
      slug: 'acme',
      tenantId: 'tenant-1',
      state: {
        activeUrl: 'https://chat.example.com',
        endpoints: [{ kind: 'default', host: null, active: false }],
      },
    });
  const customActive = {
    slug: 'acme',
    tenantId: 'tenant-1',
    state: {
      activeUrl: 'https://chat.example.com',
      endpoints: [{ kind: 'custom', host: 'chat.example.com', active: true }],
    },
  };

  it('is matched by the proxy on the default host and on a custom authority', () => {
    for (const url of [
      entryUrl,
      'https://chat.example.com/__entry',
      'http://localhost:3010/__entry',
    ])
      expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url })).toBe(true);
  });

  it('enters the organization root when the organization session is valid', async () => {
    const release = releases();
    const response = await middleware(documentNavigation(entryPath, { cookie: 'lh_x=1' }));
    await expectFragmentRedirect(response, `${ACTIVE}/#`);
    expect(mocks.enterSlug).toHaveBeenCalledWith('acme');
    expect(release).toHaveBeenCalledTimes(1);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('asks Better Auth for the persisted session only, with fixed query and the browser cookies', async () => {
    await middleware(
      documentNavigation(`${entryPath}?disableCookieCache=false&disableRefresh=false&x=secret`, {
        cookie: 'lh_x.session_token=t',
      }),
    );
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    const call = mocks.getSession.mock.calls[0][0];
    expect(call.returnHeaders).toBe(true);
    expect(call.query).toEqual({ disableRefresh: true, disableCookieCache: true });
    expect(Object.keys(call).sort()).toEqual(['headers', 'query', 'returnHeaders']);
    expect(new Headers(call.headers).get('cookie')).toBe('lh_x.session_token=t');
  });

  it('discards inbound query and fragment context on the way to the organization root', async () => {
    const response = await middleware(
      documentNavigation(
        `${entryPath}?token=secret&callbackUrl=https://evil.example&hl=en-US#frag`,
      ),
    );
    await expectFragmentRedirect(response, `${ACTIVE}/#`);
  });

  it.each([
    ['missing', { headers: new Headers(), response: null }],
    ['expired or revoked', { headers: new Headers(), response: { session: null } }],
  ])('sends a %s session to the organization finder', async (_name, result) => {
    const release = releases();
    mocks.getSession.mockResolvedValue(result);
    const response = await middleware(documentNavigation(entryPath));
    await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
    expect(release).toHaveBeenCalledTimes(1);
    expect(memoryCookie(response)).toEqual([]);
  });

  it('carries the cookies Better Auth clears for a revoked session into the final response', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'lh_x.session_token=; Max-Age=0; Path=/t/acme; HttpOnly');
    headers.append('set-cookie', 'lh_x.session_data.0=; Max-Age=0; Path=/t/acme; HttpOnly');
    mocks.getSession.mockResolvedValue({ headers, response: null });
    const response = await middleware(documentNavigation(entryPath, { cookie: 'lh_x=1' }));
    await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
  });

  it('also carries Better Auth cookies on a valid session', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'lh_x.session_data=abc; Path=/t/acme; HttpOnly');
    mocks.getSession.mockResolvedValue({ headers, response: { user: { id: 'user-1' } } });
    const response = await middleware(documentNavigation(entryPath));
    await expectFragmentRedirect(response, `${ACTIVE}/#`);
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
  });

  it("hides only this tenant's session-data cookie and its chunks from the session lookup", async () => {
    const cases: [string, string][] = [
      [
        'lh_x.session_token=t; lh_x.session_data=%%%not-base64; theme=dark',
        'lh_x.session_token=t; theme=dark',
      ],
      [
        'lh_x.session_data.0=AAAA; lh_x.session_token=t; lh_x.session_data.1=BBBB',
        'lh_x.session_token=t',
      ],
      [
        'lh_x.session_token=t; __Secure-lh_x.session_data=zz; __Secure-lh_x.session_data.0=zz',
        'lh_x.session_token=t',
      ],
      // Neither another tenant's cookies nor look-alike names are touched.
      [
        'lh_x.session_token=t; lh_y.session_data=keep; lh_x.session_data_other=keep; lh_x.session_dataX=keep',
        'lh_x.session_token=t; lh_y.session_data=keep; lh_x.session_data_other=keep; lh_x.session_dataX=keep',
      ],
    ];
    for (const [cookie, forwarded] of cases) {
      mocks.getSession.mockClear();
      const response = await middleware(documentNavigation(entryPath, { cookie }));
      await expectFragmentRedirect(response, `${ACTIVE}/#`);
      expect(new Headers(mocks.getSession.mock.calls[0][0].headers).get('cookie')).toBe(forwarded);
    }
  });

  it('forwards no cookie header at all when only the cache cookie was present', async () => {
    await middleware(documentNavigation(entryPath, { cookie: 'lh_x.session_data=zzz' }));
    expect(new Headers(mocks.getSession.mock.calls[0][0].headers).has('cookie')).toBe(false);
  });

  it('takes the cookie name from the tenant auth instance rather than a fixed pattern', async () => {
    mocks.getTenantAuth.mockResolvedValue({
      $context: Promise.resolve({ authCookies: sessionDataCookie('other_prefix.session_data') }),
      api: { getSession: mocks.getSession },
    });
    await middleware(
      documentNavigation(entryPath, {
        cookie: 'other_prefix.session_data=x; lh_x.session_data=y; other_prefix.session_token=t',
      }),
    );
    expect(new Headers(mocks.getSession.mock.calls[0][0].headers).get('cookie')).toBe(
      'lh_x.session_data=y; other_prefix.session_token=t',
    );
  });

  it('answers 503 when the auth context cannot be read, never "no session"', async () => {
    const release = releases();
    mocks.getTenantAuth.mockResolvedValue({
      $context: Promise.reject(new Error('context failed')),
      api: { getSession: mocks.getSession },
    });
    const response = await middleware(documentNavigation(entryPath));
    expect(response.status).toBe(503);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe('cleanup of the cache cookies hidden from the session lookup', () => {
    const setCookieNames = (response: Response) =>
      response.headers.getSetCookie().map((cookie) => cookie.split('=')[0]);

    it('adds expiry for the hidden chunks to the final navigation response, with the instance attributes', async () => {
      const headers = new Headers();
      headers.append('set-cookie', 'lh_x.session_token=; Max-Age=0; Path=/t/acme; HttpOnly');
      headers.append('set-cookie', 'lh_x.session_data=; Max-Age=0; Path=/t/acme; HttpOnly');
      mocks.getSession.mockResolvedValue({ headers, response: null });
      const response = await middleware(
        documentNavigation(entryPath, {
          cookie:
            'lh_x.session_token=t; lh_x.session_data.0=AAAA; lh_x.session_data.1=BBBB; lh_y.session_data.0=other',
        }),
      );
      await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
      expect(response.headers.getSetCookie()).toEqual([
        ...headers.getSetCookie(),
        'lh_x.session_data.0=; Max-Age=0; Path=/t/acme; HttpOnly; SameSite=Lax',
        'lh_x.session_data.1=; Max-Age=0; Path=/t/acme; HttpOnly; SameSite=Lax',
      ]);
    });

    it('clears a damaged cache next to a valid session without touching the token', async () => {
      const response = await middleware(
        documentNavigation(entryPath, {
          cookie: 'lh_x.session_token=t; lh_x.session_data.0=%%%; lh_x.session_data.1=%%%',
        }),
      );
      await expectFragmentRedirect(response, `${ACTIVE}/#`);
      expect(setCookieNames(response)).toEqual(['lh_x.session_data.0', 'lh_x.session_data.1']);
    });

    it('does not repeat or override a cookie Better Auth already answers', async () => {
      const headers = new Headers();
      headers.append('set-cookie', 'lh_x.session_data.0=fresh; Path=/t/acme; Max-Age=300');
      mocks.getSession.mockResolvedValue({ headers, response: { user: { id: 'u' } } });
      const response = await middleware(
        documentNavigation(entryPath, {
          cookie: 'lh_x.session_token=t; lh_x.session_data.0=old; lh_x.session_data.1=old',
        }),
      );
      expect(response.headers.getSetCookie()).toEqual([
        'lh_x.session_data.0=fresh; Path=/t/acme; Max-Age=300',
        'lh_x.session_data.1=; Max-Age=0; Path=/t/acme; HttpOnly; SameSite=Lax',
      ]);
    });

    it('sets no cleanup when the lookup itself fails', async () => {
      mocks.getSession.mockRejectedValue(new Error('db down'));
      const response = await middleware(
        documentNavigation(entryPath, { cookie: 'lh_x.session_token=t; lh_x.session_data.0=x' }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('end to end with a real Better Auth instance: a revoked session leaves no cookie behind', async () => {
      const db = { account: [], session: [], user: [], verification: [] };
      const auth = betterAuth({
        advanced: { cookiePrefix: 'lh_x', defaultCookieAttributes: { path: '/t/acme' } },
        baseURL: 'http://localhost:3010',
        database: memoryAdapter(db),
        emailAndPassword: { enabled: true },
        logger: { disabled: true },
        secret: 'isolated-proxy-entry-secret-0123456789-0123456789',
        session: { cookieCache: { enabled: false }, storeSessionInDatabase: true },
      });
      const signUp = await auth.api.signUpEmail({
        body: { email: 'p@example.invalid', name: 'P', password: 'proxy-password-123456' },
        returnHeaders: true,
      });
      const token = signUp.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .find((pair) => pair.includes('.session_token='))!;
      mocks.getTenantAuth.mockResolvedValue(auth);
      mocks.getSession.mockImplementation(undefined as never);
      const cookie = `${token}; lh_x.session_data.0=AAAA; lh_x.session_data.1=%%%`;

      const valid = await middleware(documentNavigation(entryPath, { cookie }));
      await expectFragmentRedirect(valid, `${ACTIVE}/#`);
      expect(setCookieNames(valid)).toEqual(['lh_x.session_data.0', 'lh_x.session_data.1']);

      db.session.length = 0;
      const revoked = await middleware(documentNavigation(entryPath, { cookie }));
      await expectFragmentRedirect(revoked, 'http://localhost:3010/?switch=1#');
      expect(setCookieNames(revoked)).toEqual(
        expect.arrayContaining([
          'lh_x.session_data',
          'lh_x.session_data.0',
          'lh_x.session_data.1',
          'lh_x.session_token',
        ]),
      );
      for (const cleared of revoked.headers.getSetCookie()) {
        expect(cleared).toContain('Max-Age=0');
        expect(cleared).toContain('Path=/t/acme');
      }
    });
  });

  it.each([
    ['frozen', new TenantGateError('TENANT_FROZEN', { freezeReasons: ['manual'] })],
    ['offline', new TenantGateError('TENANT_OFFLINE')],
    ['expired', new TenantGateError('TENANT_EXPIRED')],
    ['not activated', new TenantGateError('TENANT_NOT_READY', undefined, { source: 'admission' })],
    [
      'refused again inside the database driver',
      Object.assign(new Error('Failed query'), { cause: new TenantGateError('TENANT_FROZEN') }),
    ],
  ])(
    'shows the organization unavailable page for a %s organization without judging the session',
    async (_name, error) => {
      mocks.enterSlug.mockRejectedValue(error);
      const response = await middleware(documentNavigation(entryPath, { cookie: 'lh_x=1' }));
      await expectFragmentRedirect(response, `${ACTIVE}/#`);
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.getTenantAuth).not.toHaveBeenCalled();
      expect(memoryCookie(response)).toEqual([]);
    },
  );

  it('sends a vanished organization to the organization finder', async () => {
    mocks.enterSlug.mockRejectedValue(
      Object.assign(new Error('gone'), { code: 'TENANT_NOT_FOUND' }),
    );
    const response = await middleware(documentNavigation(entryPath));
    await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
    expect(memoryCookie(response)).toEqual([]);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a runtime failure opening the tenant database',
      new TenantGateError('TENANT_NOT_READY', undefined, {
        cause: new Error('connect ECONNREFUSED'),
        source: 'infrastructure',
      }),
    ],
    ['an unavailable runtime', new TenantGateError('TENANT_UNAVAILABLE')],
    ['an unrecognized failure', new Error('boom')],
    ['a non-error rejection', undefined],
  ])(
    'answers 503 with a retry back to the entry for %s, never "no session"',
    async (_name, error) => {
      mocks.enterSlug.mockRejectedValue(error);
      const response = await middleware(
        documentNavigation(`${entryPath}?token=secret`, { cookie: 'lh_x=1' }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('retry-after')).toBe('5');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.getSetCookie()).toEqual([]);
      const html = await response.text();
      expect(html).toContain(`href="${entryUrl}#"`);
      expect(html).not.toContain('secret');
      expect(mocks.getSession).not.toHaveBeenCalled();
    },
  );

  it('retries a custom authority at its own entry', async () => {
    mocks.findHost.mockResolvedValue(customActive);
    mocks.enterSlug.mockRejectedValue(new Error('boom'));
    const response = await middleware(
      new NextRequest('https://chat.example.com/__entry', {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('href="https://chat.example.com/__entry#"');
  });

  it.each([
    [
      'the auth instance cannot be built',
      () => mocks.getTenantAuth.mockRejectedValue(new Error('x')),
    ],
    ['the session query fails', () => mocks.getSession.mockRejectedValue(new Error('db down'))],
  ])('answers 503, releases the scope once and sets no cookies when %s', async (_name, arrange) => {
    const release = releases();
    arrange();
    const response = await middleware(documentNavigation(entryPath, { cookie: 'lh_x=1' }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(`href="${entryUrl}#"`);
    expect(release).toHaveBeenCalledTimes(1);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('releases the scope exactly once on every outcome that holds one', async () => {
    for (const outcome of [
      { headers: new Headers(), response: { user: { id: 'u' } } },
      { headers: new Headers(), response: null },
      new Error('db down'),
    ]) {
      const release = releases();
      if (outcome instanceof Error) mocks.getSession.mockRejectedValue(outcome);
      else mocks.getSession.mockResolvedValue(outcome);
      await middleware(documentNavigation(entryPath));
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it('survives a failing release without losing the decision', async () => {
    const release = releases();
    release.mockRejectedValue(new Error('release failed'));
    const response = await middleware(documentNavigation(entryPath));
    await expectFragmentRedirect(response, `${ACTIVE}/#`);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no memory', undefined],
    ['the same memory', 'lobe-last-tenant=tenant-1'],
    ['a different memory', 'lobe-last-tenant=tenant-other'],
  ])('never writes the memory cookie (%s)', async (_name, cookie) => {
    for (const result of [
      { headers: new Headers(), response: { user: { id: 'u' } } },
      { headers: new Headers(), response: null },
    ]) {
      mocks.getSession.mockResolvedValue(result);
      const response = await middleware(documentNavigation(entryPath, cookie ? { cookie } : {}));
      expect(memoryCookie(response)).toEqual([]);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it.each([
    ['HEAD', () => documentNavigation(entryPath, {}, 'HEAD')],
    ['POST', () => documentNavigation(entryPath, {}, 'POST')],
    ['fetch without Fetch Metadata', () => new NextRequest(entryUrl)],
    [
      'fetch (cors/empty)',
      () => documentNavigation(entryPath, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }),
    ],
    ['prefetch', () => documentNavigation(entryPath, { purpose: 'prefetch' })],
    [
      'sec-purpose prefetch',
      () => documentNavigation(entryPath, { 'sec-purpose': 'prefetch;prerender' }),
    ],
  ])('refuses %s with 404 without touching the session or the memory', async (_name, request) => {
    for (const arrange of [() => undefined, inactiveDefault]) {
      arrange();
      const response = await middleware(request());
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ code: 'NOT_FOUND' });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    }
    expect(mocks.enterSlug).not.toHaveBeenCalled();
    expect(mocks.getTenantAuth).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('moves a document navigation on a deactivated endpoint to the active entry, dropping all context, with no memory write', async () => {
    inactiveDefault();
    const response = await middleware(
      documentNavigation(
        `${entryPath}?token=secret&email=a@example.com&hl=en-US&utm_source=x#frag`,
        {
          cookie: 'lobe-last-tenant=tenant-other',
        },
      ),
    );
    await expectFragmentRedirect(response, 'https://chat.example.com/__entry#');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mocks.enterSlug).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('moves a deactivated custom authority the same way', async () => {
    mocks.findHost.mockResolvedValue({
      ...customActive,
      state: {
        activeUrl: 'https://new.example.com',
        endpoints: [{ kind: 'custom', host: 'chat.example.com', active: false }],
      },
    });
    const response = await middleware(
      new NextRequest('https://chat.example.com/__entry?code=secret', {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }),
    );
    await expectFragmentRedirect(response, 'https://new.example.com/__entry#');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('normalizes a trailing slash with a same-origin 308 and neither checks the session nor writes memory', async () => {
    const response = await middleware(documentNavigation(`${entryPath}/?token=secret`));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(entryUrl);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.enterSlug).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    const head = await middleware(documentNavigation(`${entryPath}/`, {}, 'HEAD'));
    expect(head.status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('sends a trailing-slash spelling on a deactivated endpoint to the active entry with the fragment cleared', async () => {
    inactiveDefault();
    const response = await middleware(documentNavigation(`${entryPath}/?token=secret`));
    await expectFragmentRedirect(response, 'https://chat.example.com/__entry#');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mocks.enterSlug).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('works on a custom authority', async () => {
    mocks.findHost.mockResolvedValue(customActive);
    mocks.enterSlug.mockImplementation(async (slug: string) => ({
      release: async () => {},
      scope: {
        slug,
        tenantId: 'tenant-1',
        endpoint: { basePath: '', publicUrl: 'https://chat.example.com', version: 1 },
      },
    }));
    const response = await middleware(
      new NextRequest('https://chat.example.com/__entry', {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }),
    );
    await expectFragmentRedirect(response, 'https://chat.example.com/#');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('refuses an unregistered authority and a tenant prefix on a custom authority', async () => {
    const unknown = await middleware(
      new NextRequest('https://unknown.example.com/__entry', {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }),
    );
    expect(unknown.status).toBe(404);
    mocks.findHost.mockResolvedValue(customActive);
    const prefixed = await middleware(
      new NextRequest('https://chat.example.com/t/acme/__entry', {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      }),
    );
    expect(prefixed.status).toBe(404);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('sends an unknown slug to the organization finder without writing memory', async () => {
    const response = await middleware(documentNavigation('/t/nope/__entry'));
    await expectFragmentRedirect(response, 'http://localhost:3010/?switch=1#');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect((await middleware(new NextRequest('http://localhost:3010/t/nope/__entry'))).status).toBe(
      404,
    );
  });

  it('does not confuse a nested or look-alike path with the entry', async () => {
    for (const path of ['/t/acme/__entry/x', '/t/acme/__entryx', '/t/acme/a/__entry']) {
      mocks.getSession.mockClear();
      const response = await middleware(documentNavigation(path));
      expect(response.headers.get('location')).toBeNull();
      expect(new URL(response.headers.get('x-middleware-rewrite')!).pathname).toMatch(/^\/spa\//);
    }
  });
});
