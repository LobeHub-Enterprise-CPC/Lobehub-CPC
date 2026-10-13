import { describe, expect, it } from 'vitest';

import { resolveHostTenantRoute } from '../hostRouting';

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
describe('trusted host routing', () => {
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
    expect(await route('http://internal:3010/t/acme/signin')).toMatchObject({ kind: 'reject' });
    expect(await route('http://internal:3010/t/acme/api/auth')).toMatchObject({ kind: 'reject' });
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
    expect(
      await route('https://app.example.com/api/internal/control-plane/tenant-endpoints', 'POST'),
    ).toEqual({ kind: 'tenantless-backend' });
    expect(
      await route('https://chat.example.com/api/internal/control-plane/tenant-endpoints', 'POST'),
    ).toMatchObject({ kind: 'reject' });
    expect(
      await route(
        'https://app.example.com/t/beta/api/internal/control-plane/tenant-endpoints',
        'POST',
      ),
    ).toMatchObject({ kind: 'reject' });
  });
});
