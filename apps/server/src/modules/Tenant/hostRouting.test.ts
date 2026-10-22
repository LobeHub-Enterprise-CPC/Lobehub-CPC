import { describe, expect, it, vi } from 'vitest';

import { resolveTenantRoute } from '@/libs/next/proxy/tenantRouting';

import { resolveHostTenantRoute } from './hostRouting';

const custom = {
  slug: 'acme',
  tenantId: 'a',
  state: {
    activeUrl: 'https://chat.example.com',
    endpoints: [
      { kind: 'default', host: null, active: false },
      { kind: 'custom', host: 'chat.example.com', active: true },
      { kind: 'custom', host: 'old.example.com', active: false },
    ],
  },
};
const defaultEntry = {
  slug: 'beta',
  tenantId: 'b',
  state: {
    activeUrl: 'https://app.example.com/t/beta',
    endpoints: [{ kind: 'default', host: null, active: true }],
  },
};
const deps = {
  appUrl: 'https://app.example.com',
  internalUrl: 'http://internal:3010',
  findHost: async (host: string) =>
    ['chat.example.com', 'old.example.com'].includes(host) ? custom : null,
  findSlug: async (slug: string) =>
    slug === 'acme' ? custom : slug === 'beta' ? defaultEntry : null,
};
const route = (url: string, method = 'GET') => resolveHostTenantRoute(new URL(url), method, deps);
const entryRoute = (url: string, documentNavigation: boolean, method = 'GET') => {
  const onDefaultTenantPage = vi.fn();
  return resolveHostTenantRoute(new URL(url), method, {
    ...deps,
    documentNavigation,
    onDefaultTenantPage,
  }).then((result) => ({ onDefaultTenantPage, result }));
};
describe('trusted host routing', () => {
  it.each(['admission', 'authorize', 'tool-result', 'finalize-abandoned'])(
    'admits only the exact gateway root %s on deployment authorities without tenant lookup',
    async (endpoint) => {
      const findHost = vi.fn(deps.findHost);
      const findSlug = vi.fn(deps.findSlug);
      for (const authority of [deps.appUrl, deps.internalUrl]) {
        for (const suffix of ['', '/']) {
          const url = new URL(`${authority}/api/internal/gateway/${endpoint}${suffix}`);
          expect(resolveTenantRoute(url)).toEqual({ kind: 'tenantless-backend' });
          expect(
            await resolveHostTenantRoute(url, 'POST', { ...deps, findHost, findSlug }),
          ).toEqual({ kind: 'tenantless-backend' });
        }
      }
      expect(findHost).not.toHaveBeenCalled();
      expect(findSlug).not.toHaveBeenCalled();
      for (const authority of [
        'https://chat.example.com',
        'https://old.example.com',
        'https://unknown.example.com',
        'https://app.example.com:444',
        'http://internal:3011',
      ])
        expect(await route(`${authority}/api/internal/gateway/${endpoint}`, 'POST')).toMatchObject({
          kind: 'reject',
          status: 404,
        });
      for (const authority of [deps.appUrl, deps.internalUrl]) {
        for (const path of [
          `/t/beta/api/internal/gateway/${endpoint}`,
          `/api/internal/gateway/${endpoint}/extra`,
          `/api/internal/gateway/${endpoint}-extra`,
          `/api/internal/gateway/extra-${endpoint}`,
          '/api/internal/gateway/unknown',
        ]) {
          expect(resolveTenantRoute(new URL(`${authority}${path}`)).kind).toBe('reject');
          expect(await route(`${authority}${path}`, 'POST')).toMatchObject({ kind: 'reject' });
        }
      }
    },
  );
  it('carries documented navigation queries but drops secrets and unknown fields on both inactive authorities', async () => {
    for (const prefix of ['https://app.example.com/t/acme', 'https://old.example.com']) {
      const result = await route(
        `${prefix}/resource?tab=files&page=2&q=report&code=secret&state=s&access_token=t&refresh_token=r&id_token=i&token=t&password=p&email=e&callbackURL=u&redirect_uri=u&unknown=x&CODE=c`,
      );
      expect(result).toEqual({
        kind: 'redirect',
        url: 'https://chat.example.com/resource?tab=files&page=2&q=report',
      });
    }
  });
  it('resolves default paths only on the platform authority', async () => {
    expect(await route('https://app.example.com/t/beta/agent')).toEqual({
      kind: 'tenant-page',
      slug: 'beta',
      path: '/agent',
    });
    expect(await route('https://evil.example.com/t/beta/api/auth')).toMatchObject({
      kind: 'reject',
      status: 404,
    });
    expect(await route('https://app.example.com:444/t/beta/agent')).toMatchObject({
      kind: 'reject',
    });
  });
  it('routes custom root and refuses every tenant path on it', async () => {
    expect(await route('https://chat.example.com/api/auth')).toEqual({
      kind: 'tenant-backend',
      slug: 'acme',
      path: '/api/auth',
    });
    expect(await route('https://chat.example.com/t/beta/api/auth')).toMatchObject({
      kind: 'reject',
    });
    expect(await route('https://chat.example.com/t/acme/signin')).toMatchObject({ kind: 'reject' });
  });
  it('redirects only inactive page navigation and keeps query', async () => {
    expect(
      await route('https://app.example.com/t/acme/agent?hl=en-US&code=secret&state=secret'),
    ).toEqual({ kind: 'redirect', url: 'https://chat.example.com/agent?hl=en-US' });
    expect(await route('https://old.example.com/agent', 'HEAD')).toEqual({
      kind: 'redirect',
      url: 'https://chat.example.com/agent',
    });
    for (const [path, method] of [
      ['/t/acme/api/auth', 'GET'],
      ['/t/acme/agent', 'POST'],
      ['/t/acme/oauth/consent/code', 'GET'],
      ['/t/acme/market-auth-callback?code=secret&state=secret', 'GET'],
    ])
      expect(await route(`https://app.example.com${path}`, method)).toEqual({
        kind: 'endpoint-changed',
        activeUrl: 'https://chat.example.com',
      });
  });
  it('allows authenticated internal transports without admitting browser surfaces', async () => {
    expect(await route('http://internal:3010/t/acme/trpc/async', 'POST')).toMatchObject({
      kind: 'tenant-backend',
      slug: 'acme',
    });
    for (const path of ['/signin', '/api/auth', '/agent', '/t/acme/signin', '/t/acme/api/auth'])
      expect(await route(`http://internal:3010${path}`)).toMatchObject({ kind: 'reject' });
  });
  it('keeps queued authenticated callbacks when internal and platform hosts coincide', async () => {
    const sameHost = { ...deps, internalUrl: deps.appUrl };
    for (const path of [
      '/api/workflows/task/run',
      '/trpc/async',
      '/api/agent',
      '/api/agent/run',
      '/api/webhooks/video/fal',
    ]) {
      expect(
        await resolveHostTenantRoute(
          new URL(`https://app.example.com/t/acme${path}`),
          'POST',
          sameHost,
        ),
      ).toMatchObject({ kind: 'tenant-backend', slug: 'acme', path });
    }
    expect(
      await resolveHostTenantRoute(
        new URL('https://app.example.com/t/acme/api/auth/callback/google'),
        'POST',
        sameHost,
      ),
    ).toMatchObject({ kind: 'endpoint-changed' });
  });
  it('keeps internal root interfaces off custom hosts and tenant mirrors', async () => {
    for (const path of ['/api/internal/control-plane/tenant-endpoints', '/api/cron/daily']) {
      for (const authority of [deps.appUrl, deps.internalUrl])
        expect(await route(`${authority}${path}`, 'POST')).toEqual({ kind: 'tenantless-backend' });
      for (const prefix of ['https://chat.example.com', 'https://app.example.com/t/beta'])
        expect(await route(`${prefix}${path}`, 'POST')).toMatchObject({ kind: 'reject' });
    }
  });
  it('answers an unknown slug with what the same path gets without a tenant', async () => {
    for (const path of [
      '/agent',
      '/trpc/lambda/x',
      '/api/auth/get-session',
      '/f/id',
      '/api/version',
    ]) {
      const unknown = await route(`https://app.example.com/t/nope${path}`, 'POST');
      expect(unknown).toMatchObject({ kind: 'unknown-tenant', slug: 'nope' });
      const without = await route(`https://app.example.com${path}`, 'POST');
      expect((unknown as { fallback: unknown }).fallback).toMatchObject(without);
    }
    expect(await route('https://app.example.com/t/nope/api/auth/get-session')).toEqual({
      kind: 'unknown-tenant',
      slug: 'nope',
      fallback: { kind: 'reject', code: 'TENANT_REQUIRED', status: 400 },
    });
  });
});

describe('discovery deployment boundary', () => {
  it.each([
    '/api/tenant-discovery',
    '/api/tenant-discovery/select',
    '/api/tenant-discovery/desktop-handoff',
  ])('serves %s only on the default host without a tenant prefix', async (path) => {
    expect(resolveTenantRoute(new URL(`https://app.example.com${path}`))).toEqual({
      kind: 'tenantless-backend',
    });
    for (const slug of ['beta', 'nope'])
      expect(resolveTenantRoute(new URL(`https://app.example.com/t/${slug}${path}`))).toEqual({
        kind: 'reject',
        code: 'NOT_FOUND',
        status: 404,
      });
    expect(await route(`https://app.example.com${path}`, 'POST')).toEqual({
      kind: 'tenantless-backend',
    });
    for (const prefix of [
      'http://internal:3010',
      'https://chat.example.com',
      'https://old.example.com',
      'https://app.example.com/t/beta',
      'https://app.example.com/t/nope',
      'https://app.example.com/t/INVALID',
      'https://app.example.com/t/',
    ])
      expect(await route(`${prefix}${path}`, 'POST')).toMatchObject({
        kind: 'reject',
        status: 404,
      });
  });
});

describe('session entry (/__entry)', () => {
  it('hands an active default endpoint to the session check without recording the visit', async () => {
    const { onDefaultTenantPage, result } = await entryRoute(
      'https://app.example.com/t/beta/__entry',
      true,
    );
    expect(result).toEqual({
      kind: 'session-entry',
      slug: 'beta',
      activeUrl: 'https://app.example.com/t/beta',
    });
    expect(onDefaultTenantPage).not.toHaveBeenCalled();
  });
  it('still records an ordinary explicit visit, so the entry exception stays narrow', async () => {
    const { onDefaultTenantPage } = await entryRoute('https://app.example.com/t/beta/agent', true);
    expect(onDefaultTenantPage).toHaveBeenCalledTimes(1);
  });
  it('hands an active custom host to the session check', async () => {
    const { result } = await entryRoute('https://chat.example.com/__entry', true);
    expect(result).toEqual({
      kind: 'session-entry',
      slug: 'acme',
      activeUrl: 'https://chat.example.com',
    });
  });
  it.each([
    ['https://app.example.com/t/beta/__entry', 'GET', false],
    ['https://app.example.com/t/beta/__entry', 'HEAD', false],
    ['https://app.example.com/t/beta/__entry', 'POST', false],
    ['https://app.example.com/t/beta/__entry/', 'GET', false],
    ['https://chat.example.com/__entry', 'GET', false],
    ['https://chat.example.com/__entry/', 'GET', false],
    // An inactive endpoint answers a non-document request exactly like an active one.
    ['https://app.example.com/t/acme/__entry', 'GET', false],
    ['https://app.example.com/t/acme/__entry', 'HEAD', false],
    ['https://old.example.com/__entry', 'GET', false],
  ])(
    'refuses %s (%s, document navigation %s) without recording or redirecting',
    async (url, method, nav) => {
      const { onDefaultTenantPage, result } = await entryRoute(url, nav, method);
      expect(result).toEqual({ kind: 'reject', code: 'NOT_FOUND', status: 404 });
      expect(onDefaultTenantPage).not.toHaveBeenCalled();
    },
  );
  it('refuses a request whose navigation status was never supplied', async () => {
    expect(await route('https://app.example.com/t/beta/__entry')).toEqual({
      kind: 'reject',
      code: 'NOT_FOUND',
      status: 404,
    });
  });
  it.each([
    'https://app.example.com/t/acme/__entry?token=secret&email=a@example.com&callbackUrl=https://evil.example',
    'https://old.example.com/__entry?code=secret&hl=en-US',
  ])('moves an inactive endpoint to the active one dropping every query field: %s', async (url) => {
    const { onDefaultTenantPage, result } = await entryRoute(url, true);
    expect(result).toEqual({
      kind: 'navigation-redirect',
      url: 'https://chat.example.com/__entry#',
    });
    expect(onDefaultTenantPage).not.toHaveBeenCalled();
  });
  it('normalizes a trailing slash on an active endpoint to the same origin and nothing else', async () => {
    for (const [url, target] of [
      [
        'https://app.example.com/t/beta/__entry/?x=secret',
        'https://app.example.com/t/beta/__entry',
      ],
      ['https://chat.example.com/__entry/', 'https://chat.example.com/__entry'],
    ]) {
      const { onDefaultTenantPage, result } = await entryRoute(url, true);
      expect(result).toEqual({ kind: 'redirect', status: 308, url: target });
      expect(onDefaultTenantPage).not.toHaveBeenCalled();
    }
  });
  it('keeps the same-origin spelling when another endpoint is the primary one', async () => {
    const both = {
      ...custom,
      state: {
        activeUrl: 'https://chat.example.com',
        endpoints: [
          { kind: 'default', host: null, active: true },
          { kind: 'custom', host: 'chat.example.com', active: true },
        ],
      },
    };
    const result = await resolveHostTenantRoute(
      new URL('https://app.example.com/t/acme/__entry/'),
      'GET',
      { ...deps, documentNavigation: true, findSlug: async () => both },
    );
    expect(result).toEqual({
      kind: 'redirect',
      status: 308,
      url: 'https://app.example.com/t/acme/__entry',
    });
  });
  it.each([
    'https://app.example.com/t/acme/__entry/?token=secret',
    'https://old.example.com/__entry/?code=secret',
  ])(
    'moves a deactivated endpoint straight to the active entry, clearing the fragment: %s',
    async (url) => {
      const { onDefaultTenantPage, result } = await entryRoute(url, true);
      expect(result).toEqual({
        kind: 'navigation-redirect',
        url: 'https://chat.example.com/__entry#',
      });
      expect(onDefaultTenantPage).not.toHaveBeenCalled();
    },
  );
  it('treats an unknown slug like any unknown tenant page and an unknown host as unknown', async () => {
    const { onDefaultTenantPage, result } = await entryRoute(
      'https://app.example.com/t/nope/__entry',
      true,
    );
    expect(result).toMatchObject({ kind: 'unknown-tenant', slug: 'nope' });
    expect(onDefaultTenantPage).not.toHaveBeenCalled();
    expect((await entryRoute('https://other.example.com/__entry', true)).result).toMatchObject({
      kind: 'reject',
      status: 404,
    });
    expect(
      (await entryRoute('https://chat.example.com/t/beta/__entry', true)).result,
    ).toMatchObject({ kind: 'reject' });
  });
  it('is not reachable through the internal authority', async () => {
    expect((await entryRoute('http://internal:3010/t/beta/__entry', true)).result).toMatchObject({
      kind: 'reject',
    });
  });
});
