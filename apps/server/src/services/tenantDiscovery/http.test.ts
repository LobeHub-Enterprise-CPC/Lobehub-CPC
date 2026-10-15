import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoveryIpBucket, emailFingerprint, handleTenantDiscovery } from './http';

const deps = vi.hoisted(() => ({
  candidates: vi.fn(),
  lookup: vi.fn(),
  query: vi.fn(),
  verify: vi.fn(),
  admit: vi.fn(),
  getDesktop: vi.fn(),
  putDesktop: vi.fn(),
  readDesktop: vi.fn(),
}));
vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://app.example.com' } }));
vi.mock('@/server/services/redis', () => ({
  redisService: {
    tenantDiscovery: {
      admit: deps.admit,
      getDesktopSelection: deps.getDesktop,
      putDesktopSelection: deps.putDesktop,
      readDesktopHandoff: deps.readDesktop,
    },
  },
}));
vi.mock('./candidates', () => ({ loadDiscoveryCandidates: deps.candidates }));
vi.mock('./connection', () => ({ withLookupClient: deps.lookup }));
vi.mock('./query', async (original) => ({
  ...(await original<object>()),
  queryTenantMembership: deps.query,
  verifyCandidateObjects: deps.verify,
}));

const candidate = {
  id: 'tenant-1',
  name: 'Acme',
  activeUrl: 'https://acme.example.com',
  endpointVersion: 7,
};
const flow = { state: 'a'.repeat(32), codeChallenge: 'a'.repeat(43) };
const request = (
  body: unknown,
  options: { host?: string; origin?: string; headers?: Record<string, string> } = {},
) =>
  new Request(`https://${options.host ?? 'app.example.com'}/api/tenant-discovery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': options.origin ?? 'https://app.example.com',
      'x-real-ip': '192.0.2.1',
      ...options.headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KEY_VAULTS_SECRET', 'temporary-key');
  deps.candidates.mockResolvedValue([candidate]);
  deps.lookup.mockImplementation(async (_signal, fn) => fn({}));
  deps.query.mockResolvedValue([candidate]);
  deps.verify.mockResolvedValue(undefined);
  deps.admit.mockResolvedValue(null);
  deps.getDesktop.mockResolvedValue(null);
  deps.putDesktop.mockImplementation(async (_key, value) => value);
  deps.readDesktop.mockResolvedValue({
    tenantId: candidate.id,
    entry: candidate.activeUrl,
    name: candidate.name,
    endpointVersion: 7,
    codeChallenge: flow.codeChallenge,
    expiresAt: Date.now() + 600000,
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('discovery HTTP boundary', () => {
  it.each(['other.example.com', 'internal.example.com'])(
    'rejects non-default host %s before any directory query',
    async (host) => {
      const response = await handleTenantDiscovery(
        request({ email: 'a@example.com' }, { host }),
        'discovery',
      );
      expect(response.status).toBe(404);
      expect(deps.candidates).not.toHaveBeenCalled();
      expect(deps.admit).not.toHaveBeenCalled();
    },
  );
  it.each([
    'x'.repeat(1025),
    JSON.stringify({ email: 'invalid' }),
    '{',
    JSON.stringify({ email: 'a@example.com', extra: true }),
  ])('rejects invalid or oversized actual bodies', async (body) => {
    expect((await handleTenantDiscovery(request(body), 'discovery')).status).toBe(400);
    expect(deps.candidates).not.toHaveBeenCalled();
    expect(deps.admit).not.toHaveBeenCalled();
  });
  it('normalizes email but returns only organization identifiers and display labels', async () => {
    const response = await handleTenantDiscovery(
      request({ email: ' A@EXAMPLE.COM ' }),
      'discovery',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenants: [{ id: 'tenant-1', name: 'Acme' }] });
    expect(deps.query.mock.lastCall?.[2]).toBe('a@example.com');
    expect(deps.admit.mock.lastCall?.[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
  it('returns 429 and Retry-After without directory queries; Redis failure returns 503', async () => {
    deps.admit.mockResolvedValueOnce(23);
    const limited = await handleTenantDiscovery(request({ email: 'a@example.com' }), 'discovery');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('23');
    deps.admit.mockRejectedValueOnce(new Error('redis offline'));
    expect(
      (await handleTenantDiscovery(request({ email: 'a@example.com' }), 'discovery')).status,
    ).toBe(503);
    expect(deps.candidates).not.toHaveBeenCalled();
  });
  it('fails the whole discovery if any candidate or lookup is unavailable', async () => {
    deps.candidates.mockRejectedValueOnce(new Error('incomplete projection'));
    expect(
      (await handleTenantDiscovery(request({ email: 'a@example.com' }), 'discovery')).status,
    ).toBe(503);
    deps.query.mockRejectedValueOnce(new Error('sensitive raw postgres error'));
    const response = await handleTenantDiscovery(request({ email: 'a@example.com' }), 'discovery');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'TENANT_DISCOVERY_UNAVAILABLE' });
  });
  it('checks select Origin before admission and does not accept arbitrary redirect URLs', async () => {
    expect(
      (
        await handleTenantDiscovery(
          request({ id: candidate.id }, { origin: 'https://evil.example' }),
          'select',
        )
      ).status,
    ).toBe(403);
    expect(deps.admit).not.toHaveBeenCalled();
    expect(
      (
        await handleTenantDiscovery(
          request({ id: candidate.id, url: 'https://evil.example' }),
          'select',
        )
      ).status,
    ).toBe(400);
    expect(deps.candidates).not.toHaveBeenCalled();
  });
  it('revalidates selection, sets host-only navigation cookie, and preserves optional normalized email', async () => {
    const response = await handleTenantDiscovery(
      request({ id: candidate.id, email: ' A@EXAMPLE.COM ' }),
      'select',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://acme.example.com/signin?email=a%40example.com',
    });
    expect(response.headers.get('Set-Cookie')).toContain('__Host-lobe-last-tenant=tenant-1');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    deps.candidates.mockResolvedValueOnce([]);
    const missing = await handleTenantDiscovery(request({ id: candidate.id }), 'select');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'TENANT_NOT_AVAILABLE' });
  });
  it('normalizes IPv4-mapped IPv6 and treats scoped or invalid IP headers as unknown', () => {
    expect(discoveryIpBucket(new Headers({ 'x-real-ip': '::ffff:192.0.2.1' }))).toBe('192.0.2.1');
    expect(discoveryIpBucket(new Headers({ 'x-real-ip': '::ffff:c000:201' }))).toBe('192.0.2.1');
    expect(discoveryIpBucket(new Headers({ 'x-real-ip': '::ffff:192.0.2.2' }))).toBe('192.0.2.2');
    expect(discoveryIpBucket(new Headers({ 'x-real-ip': '::1' }))).toBe('0:0:0:0::/64');
    expect(discoveryIpBucket(new Headers({ 'x-real-ip': 'fe80::1%eth0' }))).toBe('unknown');
    expect(discoveryIpBucket(new Headers({ 'x-real-ip': '[invalid]' }))).toBe('unknown');
  });
  it('ignores spoofed XFF and groups IPv6 clients by /64', () => {
    expect(
      discoveryIpBucket(
        new Headers({ 'x-real-ip': '2001:db8:0:1::abcd', 'x-forwarded-for': '1.2.3.4' }),
      ),
    ).toBe('2001:db8:0:1::/64');
    expect(discoveryIpBucket(new Headers({ 'x-real-ip': '2001:0db8:0:1:0:0:0:ffff' }))).toBe(
      '2001:db8:0:1::/64',
    );
    expect(discoveryIpBucket(new Headers({ 'x-forwarded-for': '1.2.3.4' }))).toBe('unknown');
    expect(emailFingerprint('a@example.com')).not.toContain('example');
  });
});

describe('desktop HTTP boundary', () => {
  it('selects desktop authorization without leaking email or double charging admission', async () => {
    const result = await handleTenantDiscovery(
      request({ id: candidate.id, email: 'a@example.com', desktop: flow }),
      'select',
    );
    expect(result.status).toBe(200);
    const url = new URL((await result.json()).url);
    expect(url.pathname).toBe('/oidc/auth');
    expect(url.searchParams.has('email')).toBe(false);
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(deps.admit).toHaveBeenCalledTimes(1);
    expect(result.headers.get('Set-Cookie')).toContain('lobe-last-tenant=tenant-1');
  });
  it('rejects malformed desktop data before Redis or DB and preserves the select Origin guard', async () => {
    expect(
      (
        await handleTenantDiscovery(
          request({ id: candidate.id, desktop: { ...flow, state: 'short' } }),
          'select',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleTenantDiscovery(
          request({ id: candidate.id, desktop: flow }, { origin: 'https://evil.example' }),
          'select',
        )
      ).status,
    ).toBe(403);
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.candidates).not.toHaveBeenCalled();
  });
  it('does not require Origin for the Redis-only handoff and returns only four snapshot fields', async () => {
    const noOrigin = request(flow);
    noOrigin.headers.delete('origin');
    const result = await handleTenantDiscovery(noOrigin, 'desktop-handoff');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      tenantId: candidate.id,
      entry: candidate.activeUrl,
      name: 'Acme',
      endpointVersion: 7,
    });
    expect(deps.candidates).not.toHaveBeenCalled();
    expect(result.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
  it('returns exact handoff errors, retry timing, and forbids nondefault hosts and oversized bodies', async () => {
    deps.readDesktop.mockResolvedValueOnce(null);
    const missing = await handleTenantDiscovery(request(flow), 'desktop-handoff');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'HANDOFF_NOT_FOUND' });
    deps.admit.mockResolvedValueOnce(14);
    const limited = await handleTenantDiscovery(request(flow), 'desktop-handoff');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('14');
    expect(
      (
        await handleTenantDiscovery(
          request(flow, { host: 'tenant.example.com' }),
          'desktop-handoff',
        )
      ).status,
    ).toBe(404);
    expect((await handleTenantDiscovery(request('x'.repeat(1025)), 'desktop-handoff')).status).toBe(
      400,
    );
    expect(deps.candidates).not.toHaveBeenCalled();
  });
  it('returns the immutable-flow conflict as 409 without writing a new cookie', async () => {
    deps.getDesktop.mockResolvedValue({
      tenantId: 'other',
      entry: 'https://other.example.com',
      name: 'Other',
      endpointVersion: 1,
      codeChallenge: flow.codeChallenge,
      expiresAt: Date.now() + 600000,
    });
    const result = await handleTenantDiscovery(
      request({ id: candidate.id, desktop: flow }),
      'select',
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ code: 'HANDOFF_EXISTS' });
    expect(result.headers.get('Set-Cookie')).toBeNull();
    expect(deps.candidates).not.toHaveBeenCalled();
  });
  it('replays desktop selections unchanged even if the current endpoint subsequently moves', async () => {
    const first = await handleTenantDiscovery(
      request({ id: candidate.id, desktop: flow }),
      'select',
    );
    const firstBody = await first.json();
    deps.getDesktop.mockResolvedValue(deps.putDesktop.mock.lastCall?.[1]);
    deps.candidates.mockRejectedValue(new Error('unavailable'));
    const replay = await handleTenantDiscovery(
      request({ id: candidate.id, desktop: flow }),
      'select',
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(deps.candidates).toHaveBeenCalledTimes(1);
  });
});
