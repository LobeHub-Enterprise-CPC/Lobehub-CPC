import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseControlPlaneToken } from '@/server/services/tenantControlPlane/auth';

import { createTenantDiscoveryInternalApp, resolveTenantDiscoveryTokenDigest } from './index';

const deps = vi.hoisted(() => ({
  admit: vi.fn(),
  candidates: vi.fn(),
  lookup: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@/envs/app', () => ({ appEnv: {} }));
vi.mock('@/server/services/redis', () => ({
  redisService: { tenantDiscovery: { admit: deps.admit } },
}));
vi.mock('@/server/services/tenantDiscovery/candidates', () => ({
  loadDiscoveryCandidates: deps.candidates,
}));
vi.mock('@/server/services/tenantDiscovery/connection', () => ({
  withLookupClient: deps.lookup,
}));
vi.mock('@/server/services/tenantDiscovery/query', () => ({
  queryTenantMembership: deps.query,
}));

const TOKEN = 'd'.repeat(32);
const CONSOLE_TOKEN = 'c'.repeat(32);
const CLIENT_IP = '192.0.2.9';
const URL_ = 'http://lobehub.internal/api/internal/tenant-discovery/lookup';

const acme = {
  activeUrl: 'https://acme.example.com',
  id: 'tenant-b',
  name: 'Acme',
  slug: 'acme',
};
const zeta = { activeUrl: 'https://zeta.example.com', id: 'tenant-a', name: 'Zeta', slug: 'zeta' };
const acme2 = { activeUrl: 'https://acme2.example.com', id: 'tenant-c', name: 'Acme', slug: 'a2' };

const setup = (tokenDigest = parseControlPlaneToken(TOKEN)) => {
  const app = createTenantDiscoveryInternalApp({ tokenDigest });
  const call = (
    body: unknown,
    init: { headers?: Record<string, string | undefined>; method?: string; path?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      'authorization': `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    };
    for (const [key, value] of Object.entries(init.headers ?? {}))
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    const method = init.method ?? 'POST';
    return app.fetch(
      new Request(init.path ?? URL_, {
        body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        headers,
        method,
      }),
    );
  };
  return { call };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KEY_VAULTS_SECRET', 'temporary-key');
  deps.admit.mockResolvedValue(null);
  deps.candidates.mockResolvedValue([zeta, acme, acme2]);
  deps.lookup.mockImplementation(async (_signal, fn) => fn({}));
  deps.query.mockResolvedValue([zeta, acme2, acme]);
});
afterEach(() => vi.unstubAllEnvs());

const expectNoBackendAccess = () => {
  expect(deps.admit).not.toHaveBeenCalled();
  expect(deps.candidates).not.toHaveBeenCalled();
  expect(deps.lookup).not.toHaveBeenCalled();
  expect(deps.query).not.toHaveBeenCalled();
};

describe('tenant discovery internal lookup', () => {
  describe('authentication', () => {
    it('answers 503 TENANT_DISCOVERY_DISABLED for every request when the token is not configured', async () => {
      const { call } = setup(null);
      const response = await call({ clientIp: CLIENT_IP, email: 'a@example.com' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'TENANT_DISCOVERY_DISABLED' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expectNoBackendAccess();
    });

    it('answers 401 TOKEN_INVALID for a wrong or missing Bearer token before touching anything', async () => {
      const { call } = setup();
      for (const authorization of [`Bearer ${'x'.repeat(32)}`, TOKEN, 'Basic abc', undefined]) {
        const response = await call('not-json', { headers: { authorization } });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ code: 'TOKEN_INVALID' });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
      expectNoBackendAccess();
    });

    it('disables the endpoint without throwing when the token equals the Console token', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const digest = resolveTenantDiscoveryTokenDigest(CONSOLE_TOKEN, CONSOLE_TOKEN);
      expect(digest).toBeNull();
      const response = await setup(digest).call({ clientIp: CLIENT_IP, email: 'a@example.com' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'TENANT_DISCOVERY_DISABLED' });
      expect(JSON.stringify(error.mock.calls)).not.toContain(CONSOLE_TOKEN);
      error.mockRestore();
    });

    it('disables the endpoint without throwing when the token is shorter than 32 characters', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const digest = resolveTenantDiscoveryTokenDigest('short-token', CONSOLE_TOKEN);
      expect(digest).toBeNull();
      expect(JSON.stringify(error.mock.calls)).not.toContain('short-token');
      const response = await setup(digest).call({ clientIp: CLIENT_IP, email: 'a@example.com' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'TENANT_DISCOVERY_DISABLED' });
      error.mockRestore();
    });

    it('accepts a distinct 32+ character token and treats an absent token as disabled', () => {
      expect(resolveTenantDiscoveryTokenDigest(TOKEN, CONSOLE_TOKEN)).toEqual(
        parseControlPlaneToken(TOKEN),
      );
      expect(resolveTenantDiscoveryTokenDigest(undefined, CONSOLE_TOKEN)).toBeNull();
    });
  });

  describe('request validation', () => {
    it('rejects a non-JSON content type with 400', async () => {
      const response = await setup().call(
        JSON.stringify({ clientIp: CLIENT_IP, email: 'a@example.com' }),
        {
          headers: { 'content-type': 'text/plain' },
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' });
      expectNoBackendAccess();
    });

    it('rejects a missing content type and malformed JSON with 400', async () => {
      const { call } = setup();
      expect((await call('{}', { headers: { 'content-type': undefined } })).status).toBe(400);
      const response = await call('{not json');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' });
      expectNoBackendAccess();
    });

    it('rejects a body over 1024 bytes with 413, with and without a declared length', async () => {
      const { call } = setup();
      const body = JSON.stringify({
        clientIp: CLIENT_IP,
        email: `${'a'.repeat(1100)}@example.com`,
      });
      const declared = await call(body, { headers: { 'content-length': String(body.length) } });
      expect(declared.status).toBe(413);
      expect(await declared.json()).toEqual({ code: 'REQUEST_TOO_LARGE' });
      const app = createTenantDiscoveryInternalApp({ tokenDigest: parseControlPlaneToken(TOKEN) });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      const undeclared = await app.fetch(
        new Request(URL_, {
          body: stream,
          // @ts-expect-error Node fetch streaming bodies require duplex.
          duplex: 'half',
          headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          method: 'POST',
        }),
      );
      expect(undeclared.status).toBe(413);
      expectNoBackendAccess();
    });

    it('still answers 413 when cancelling the oversize stream fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const app = createTenantDiscoveryInternalApp({ tokenDigest: parseControlPlaneToken(TOKEN) });
      const stream = new ReadableStream({
        cancel() {
          throw new Error('cancel failed');
        },
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(2048)));
        },
      });
      const response = await app.fetch(
        new Request(URL_, {
          body: stream,
          // @ts-expect-error Node fetch streaming bodies require duplex.
          duplex: 'half',
          headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          method: 'POST',
        }),
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ code: 'REQUEST_TOO_LARGE' });
      expect(warn).toHaveBeenCalledWith('TENANT_DISCOVERY_BODY_CANCEL_FAILED');
      warn.mockRestore();
      expectNoBackendAccess();
    });

    it.each([
      ['an invalid email', { clientIp: CLIENT_IP, email: 'not-an-email' }],
      ['a missing email', { clientIp: CLIENT_IP }],
      ['a non-string email', { clientIp: CLIENT_IP, email: 5 }],
      [
        'an email longer than 254 characters',
        { clientIp: CLIENT_IP, email: `${'a'.repeat(250)}@example.com` },
      ],
      ['an extra field', { clientIp: CLIENT_IP, email: 'a@example.com', extra: 1 }],
      ['a missing clientIp', { email: 'a@example.com' }],
      ['an empty clientIp', { clientIp: '', email: 'a@example.com' }],
      ['a null clientIp', { clientIp: null, email: 'a@example.com' }],
      ['a non-IP clientIp', { clientIp: 'not-an-ip', email: 'a@example.com' }],
      ['a scoped IPv6 clientIp', { clientIp: 'fe80::1%eth0', email: 'a@example.com' }],
      ['a non-string clientIp', { clientIp: 4, email: 'a@example.com' }],
      ['a non-object body', ['a@example.com']],
    ])('rejects %s with 400 INVALID_REQUEST', async (_name, body) => {
      const response = await setup().call(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' });
      expectNoBackendAccess();
    });
  });

  describe('rate limiting', () => {
    it('answers 429 RATE_LIMITED with Retry-After before any directory access', async () => {
      deps.admit.mockResolvedValue(42);
      const response = await setup().call({ clientIp: CLIENT_IP, email: 'a@example.com' });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ code: 'RATE_LIMITED' });
      expect(response.headers.get('retry-after')).toBe('42');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(deps.candidates).not.toHaveBeenCalled();
      expect(deps.lookup).not.toHaveBeenCalled();
    });

    it('admits with the integration kind, the client IP bucket and a hashed mailbox', async () => {
      await setup().call({ clientIp: CLIENT_IP, email: ' A@Example.com ' });
      expect(deps.admit).toHaveBeenCalledTimes(1);
      const [kind, ip, emailHash] = deps.admit.mock.calls[0];
      expect(kind).toBe('integration');
      expect(ip).toBe(CLIENT_IP);
      expect(emailHash).toMatch(/^[a-f0-9]{64}$/);
      expect(emailHash).not.toContain('example');
    });

    it('buckets the clientIp, collapsing IPv6 to /64', async () => {
      const { call } = setup();
      await call({ clientIp: '192.0.2.9', email: 'a@example.com' });
      await call({ clientIp: '2001:db8:1:2:3:4:5:6', email: 'a@example.com' });
      expect(deps.admit.mock.calls.map((callArgs) => callArgs[1])).toEqual([
        '192.0.2.9',
        '2001:db8:1:2::/64',
      ]);
    });

    it('answers 503 TENANT_DISCOVERY_UNAVAILABLE without leaking details when Redis fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      deps.admit.mockRejectedValue(new Error('REDIS_UNAVAILABLE redis://secret@host'));
      const response = await setup().call({ clientIp: CLIENT_IP, email: 'a@example.com' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'TENANT_DISCOVERY_UNAVAILABLE' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
      expect(deps.candidates).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });

  describe('lookup', () => {
    it('returns matching tenants sorted by name then id with slug, url and signinUrl', async () => {
      const response = await setup().call({ clientIp: CLIENT_IP, email: ' Dev+Tag@Example.com ' });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        tenants: [
          {
            id: 'tenant-b',
            name: 'Acme',
            signinUrl: 'https://acme.example.com/signin',
            slug: 'acme',
            url: 'https://acme.example.com',
          },
          {
            id: 'tenant-c',
            name: 'Acme',
            signinUrl: 'https://acme2.example.com/signin',
            slug: 'a2',
            url: 'https://acme2.example.com',
          },
          {
            id: 'tenant-a',
            name: 'Zeta',
            signinUrl: 'https://zeta.example.com/signin',
            slug: 'zeta',
            url: 'https://zeta.example.com',
          },
        ],
      });
      expect(deps.query).toHaveBeenCalledWith({}, [zeta, acme, acme2], 'dev+tag@example.com');
    });

    it('returns 200 with an empty list when nothing matches', async () => {
      deps.query.mockResolvedValue([]);
      const response = await setup().call({ clientIp: CLIENT_IP, email: 'nobody@example.com' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tenants: [] });
    });

    it('never puts the mailbox into signinUrl', async () => {
      const response = await setup().call({ clientIp: CLIENT_IP, email: 'Dev+Tag@Example.com' });
      const { tenants } = (await response.json()) as { tenants: { signinUrl: string }[] };
      expect(tenants).toHaveLength(3);
      for (const { signinUrl } of tenants) {
        const parsed = new URL(signinUrl);
        expect(parsed.pathname).toBe('/signin');
        expect([...parsed.searchParams.keys()]).toEqual([]);
        expect(parsed.search).toBe('');
        expect(parsed.hash).toBe('');
      }
    });

    it('does not return personal data', async () => {
      const email = 'personal.mailbox@example.com';
      const text = await (await setup().call({ clientIp: CLIENT_IP, email })).text();
      for (const value of [email, email.split('@')[0], encodeURIComponent(email)])
        expect(text.toLowerCase()).not.toContain(value.toLowerCase());
      expect(Object.keys(JSON.parse(text).tenants[0]).sort()).toEqual([
        'id',
        'name',
        'signinUrl',
        'slug',
        'url',
      ]);
    });

    it('derives url and signinUrl for a single-app path tenant', async () => {
      const acmePath = {
        activeUrl: 'https://work.example.com/t/acme',
        id: 'tenant-p',
        name: 'Acme Path',
        slug: 'acme',
      };
      deps.candidates.mockResolvedValue([acmePath]);
      deps.query.mockResolvedValue([acmePath]);
      const response = await setup().call({ clientIp: CLIENT_IP, email: 'a@example.com' });
      expect(await response.json()).toEqual({
        tenants: [
          {
            id: 'tenant-p',
            name: 'Acme Path',
            signinUrl: 'https://work.example.com/t/acme/signin',
            slug: 'acme',
            url: 'https://work.example.com/t/acme',
          },
        ],
      });
    });

    it('answers 503 without leaking the database error when the directory query fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      deps.query.mockRejectedValue(new Error('password authentication failed for user a@b.com'));
      const response = await setup().call({ clientIp: CLIENT_IP, email: 'a@example.com' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'TENANT_DISCOVERY_UNAVAILABLE' });
      expect(JSON.stringify(error.mock.calls)).not.toMatch(/password|a@b\.com|a@example\.com/);
      error.mockRestore();
    });
  });

  describe('routing', () => {
    it.each([
      ['GET', '/api/internal/tenant-discovery/lookup'],
      ['POST', '/api/internal/tenant-discovery/other'],
      ['POST', '/api/internal/tenant-discovery'],
    ])('answers 404 NOT_FOUND for %s %s', async (method, path) => {
      const response = await setup().call(
        { email: 'a@example.com' },
        {
          method,
          path: `http://lobehub.internal${path}`,
        },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expectNoBackendAccess();
    });
  });
});

describe('default instance', () => {
  afterEach(() => {
    vi.doUnmock('@/envs/app');
    vi.resetModules();
  });

  const load = async (env: Record<string, string>) => {
    vi.resetModules();
    vi.doMock('@/envs/app', () => ({ appEnv: env }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const module = await import('./index');
    error.mockRestore();
    return module.default;
  };
  const post = (app: Awaited<ReturnType<typeof load>>) =>
    app.fetch(
      new Request(URL_, {
        body: JSON.stringify({ clientIp: CLIENT_IP, email: 'a@example.com' }),
        headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

  it('is disabled when the token is unset, equal to the Console token or too short', async () => {
    for (const env of [
      {},
      { LOBEHUB_CONTROL_PLANE_TOKEN: TOKEN, LOBEHUB_TENANT_DISCOVERY_TOKEN: TOKEN },
      { LOBEHUB_TENANT_DISCOVERY_TOKEN: 'short' },
    ]) {
      const response = await post(await load(env));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'TENANT_DISCOVERY_DISABLED' });
    }
  });

  it('serves requests authenticated with the configured token', async () => {
    const response = await post(
      await load({
        LOBEHUB_CONTROL_PLANE_TOKEN: CONSOLE_TOKEN,
        LOBEHUB_TENANT_DISCOVERY_TOKEN: TOKEN,
      }),
    );
    expect(response.status).toBe(200);
  });
});
