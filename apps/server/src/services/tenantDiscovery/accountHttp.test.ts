import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serializeAccountCookie } from './accountCookie';
import { handleTenantAccount } from './accountHttp';

const deps = vi.hoisted(() => ({
  admit: vi.fn(),
  candidates: vi.fn(),
  lookup: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://app.example.com' } }));
vi.mock('@/server/services/redis', () => ({
  redisService: { tenantDiscovery: { admit: deps.admit } },
}));
vi.mock('./candidates', () => ({ loadDiscoveryCandidates: deps.candidates }));
vi.mock('./connection', () => ({ withLookupClient: deps.lookup }));
vi.mock('./query', async (original) => ({
  ...(await original<object>()),
  queryTenantMembership: deps.query,
}));

const APP = 'https://app.example.com';
const candidate = (overrides: Record<string, unknown> = {}) => ({
  activeUrl: 'https://app.example.com/t/acme',
  endpointVersion: 3,
  id: 'tenant-1',
  name: 'Acme',
  ...overrides,
});

const valueOf = (setCookie: string) => setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0];
const accountCookie = (email = 'user@example.com', tenantId = 'tenant-1') =>
  valueOf(serializeAccountCookie(email, tenantId, APP)!);

const request = (
  body: unknown,
  options: {
    cookie?: string;
    headers?: Record<string, string>;
    host?: string;
    method?: string;
    origin?: string | null;
  } = {},
) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Host': options.host ?? 'app.example.com',
    'x-real-ip': '192.0.2.1',
    ...options.headers,
  };
  if (options.origin !== null) headers.Origin = options.origin ?? APP;
  if (options.cookie) headers.Cookie = options.cookie;
  return new Request(`${APP}/api/tenant-discovery/account`, {
    body:
      options.method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    method: options.method ?? 'POST',
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KEY_VAULTS_SECRET', 'account-http-test-secret');
  deps.admit.mockResolvedValue(null);
  deps.candidates.mockResolvedValue([candidate()]);
  deps.lookup.mockImplementation(async (_signal: AbortSignal, work: (client: object) => unknown) =>
    work({}),
  );
  deps.query.mockResolvedValue([candidate()]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('account API boundary', () => {
  it.each(['other.example.com', 'internal.example.com'])(
    'rejects a non-platform host %s before Redis or the directory',
    async (host) => {
      const response = await handleTenantAccount(request({}, { host }), 'account');
      expect(response.status).toBe(404);
      expect(deps.admit).not.toHaveBeenCalled();
      expect(deps.candidates).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-POST request and a missing or foreign Origin', async () => {
    expect((await handleTenantAccount(request({}, { method: 'GET' }), 'account')).status).toBe(404);
    expect((await handleTenantAccount(request({}, { origin: null }), 'account')).status).toBe(403);
    expect(
      (await handleTenantAccount(request({}, { origin: 'https://evil.example' }), 'account'))
        .status,
    ).toBe(403);
    expect(deps.admit).not.toHaveBeenCalled();
  });

  it.each([
    ['account', '{'],
    ['account', JSON.stringify({ extra: true })],
    ['select', JSON.stringify({ id: 'tenant-1', extra: true })],
    ['select', JSON.stringify({ id: 'bad/value' })],
    ['select', '{}'],
    ['forget', JSON.stringify({ extra: true })],
  ] as const)('answers 400 for a non-strict %s body: %s', async (action, body) => {
    expect((await handleTenantAccount(request(body), action)).status).toBe(400);
    expect(deps.admit).not.toHaveBeenCalled();
  });

  it('answers 204 without a cookie and 409 on select, without clearing a cookie it never had', async () => {
    const none = await handleTenantAccount(request({}), 'account');
    expect(none.status).toBe(204);
    expect(none.headers.get('Set-Cookie')).toBeNull();

    const select = await handleTenantAccount(request({ id: 'tenant-1' }), 'select');
    expect(select.status).toBe(409);
    expect(await select.json()).toEqual({ code: 'ACCOUNT_MEMORY_MISSING' });
    expect(select.headers.get('Set-Cookie')).toBeNull();
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it.each([
    ['account', 204],
    ['select', 409],
  ] as const)('clears an unreadable cookie on a %s response', async (action, status) => {
    const response = await handleTenantAccount(
      request(action === 'select' ? { id: 'tenant-1' } : {}, {
        cookie: '__Host-lobe-last-account=not-a-value',
      }),
      action,
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('Set-Cookie')).toBe(
      '__Host-lobe-last-account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it('returns the remembered email, the eligible last organization and finder-shaped results', async () => {
    deps.candidates.mockResolvedValue([
      candidate({ id: 'tenant-2', name: 'Beta', activeUrl: 'https://app.example.com/t/beta' }),
      candidate({ id: 'tenant-1', name: 'Acme' }),
    ]);
    deps.query.mockResolvedValue([
      candidate({ id: 'tenant-2', name: 'Beta', activeUrl: 'https://app.example.com/t/beta' }),
      candidate({ id: 'tenant-1', name: 'Acme' }),
    ]);
    const response = await handleTenantAccount(
      request({}, { cookie: `__Host-lobe-last-account=${accountCookie('User@Example.com ')}` }),
      'account',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: 'user@example.com',
      lastTenantId: 'tenant-1',
      organizations: [
        { id: 'tenant-1', name: 'Acme' },
        { id: 'tenant-2', name: 'Beta' },
      ],
    });
    expect(deps.query.mock.lastCall?.[2]).toBe('user@example.com');
    expect(deps.admit.mock.lastCall?.[2]).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports a last organization that is no longer among the results as null', async () => {
    deps.query.mockResolvedValue([candidate({ id: 'tenant-2', name: 'Beta' })]);
    const response = await handleTenantAccount(
      request({}, { cookie: `__Host-lobe-last-account=${accountCookie()}` }),
      'account',
    );
    expect(await response.json()).toMatchObject({ lastTenantId: null });
  });

  it('answers 204 when the remembered email belongs to no organization', async () => {
    deps.query.mockResolvedValue([]);
    const response = await handleTenantAccount(
      request({}, { cookie: `__Host-lobe-last-account=${accountCookie()}` }),
      'account',
    );
    expect(response.status).toBe(204);
  });

  it('answers 429 with Retry-After before any directory work', async () => {
    deps.admit.mockResolvedValueOnce(17);
    const response = await handleTenantAccount(
      request({}, { cookie: `__Host-lobe-last-account=${accountCookie()}` }),
      'account',
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(await response.json()).toEqual({ code: 'RATE_LIMITED' });
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it('answers 503 without leaking the email or the raw failure', async () => {
    deps.candidates.mockRejectedValueOnce(new Error('postgres://secret@private/db'));
    const response = await handleTenantAccount(
      request({}, { cookie: `__Host-lobe-last-account=${accountCookie('private@example.com')}` }),
      'account',
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('TENANT_DISCOVERY_UNAVAILABLE');
    expect(body).not.toContain('private@example.com');
    expect(body).not.toContain('postgres://');
  });

  it('selects only an organization of the remembered email and returns its sign-in entry', async () => {
    const response = await handleTenantAccount(
      request({ id: 'tenant-1' }, { cookie: `__Host-lobe-last-account=${accountCookie()}` }),
      'select',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://app.example.com/t/acme/__entry?signin=1',
    });
    expect(response.headers.get('Set-Cookie')).toBe(
      '__Host-lobe-last-tenant=tenant-1; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax; Secure',
    );
    expect(deps.query.mock.lastCall?.[2]).toBe('user@example.com');
  });

  it.each([
    ['the organization is gone', () => deps.candidates.mockResolvedValueOnce([])],
    ['the email is not a member', () => deps.query.mockResolvedValueOnce([])],
  ])('answers 404 when %s', async (_name, arrange) => {
    arrange();
    const response = await handleTenantAccount(
      request({ id: 'tenant-1' }, { cookie: `__Host-lobe-last-account=${accountCookie()}` }),
      'select',
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'TENANT_NOT_AVAILABLE' });
  });

  it('forgets the cookie with the IP-only account budget and no directory work', async () => {
    const response = await handleTenantAccount(
      request({}, { cookie: `__Host-lobe-last-account=${accountCookie()}` }),
      'forget',
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toBe(
      '__Host-lobe-last-account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
    expect(deps.admit).toHaveBeenCalledWith('account', '192.0.2.1', undefined);
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it.each(['account', 'select', 'forget'] as const)(
    'sets private no-store and no-referrer on every %s answer',
    async (action) => {
      for (const response of [
        await handleTenantAccount(request({}, { cookie: '__Host-lobe-last-account=bad' }), action),
        await handleTenantAccount(
          request(action === 'select' ? { id: 'tenant-1' } : {}, {
            cookie: `__Host-lobe-last-account=${accountCookie()}`,
          }),
          action,
        ),
      ]) {
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      }
    },
  );
});

describe('account API error headers', () => {
  it('keeps the privacy headers on 429 and 503', async () => {
    deps.admit.mockResolvedValueOnce(9);
    const limited = await handleTenantAccount(request({}), 'account');
    expect(limited.headers.get('Cache-Control')).toBe('private, no-store');
    expect(limited.headers.get('Referrer-Policy')).toBe('no-referrer');

    deps.admit.mockResolvedValueOnce(null);
    deps.candidates.mockRejectedValueOnce(new Error('offline'));
    const unavailable = await handleTenantAccount(
      request({}, { cookie: `__Host-lobe-last-account=${accountCookie()}` }),
      'account',
    );
    expect(unavailable.headers.get('Cache-Control')).toBe('private, no-store');
    expect(unavailable.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});
