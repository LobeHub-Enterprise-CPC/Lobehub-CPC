// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  forEachTenant: vi.fn(),
  isTrustedClientEnabled: vi.fn(() => true),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn(() => 'client-id.signed'),
  isTrustedClientEnabled: mocks.isTrustedClientEnabled,
}));
vi.mock('@/server/modules/Tenant/fanOut', () => ({ forEachTenant: mocks.forEachTenant }));

const { probeMarketBinding, probeMarketBindingForAllTenants } = await import('./bindingProbe');

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
const refusal = (code: string) => ({ error: { code, message: code } });

const probeWith = (fetchImpl: typeof fetch) =>
  probeMarketBinding(TENANT_ID, { baseUrl: 'https://market.test', fetch: fetchImpl });

describe('probeMarketBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTrustedClientEnabled.mockReturnValue(true);
  });

  it('asks Market whether the signed client is admitted into the tenant, with the trust token only', async () => {
    const fetchMock = vi.fn(async () =>
      json(200, {
        clientId: 'client-id',
        instanceId: 'i1',
        ready: true,
        slug: 'acme',
        tenantId: TENANT_ID,
      }),
    );

    const result = await probeWith(fetchMock as never);

    expect(result).toEqual({ clientId: 'client-id', slug: 'acme', status: 'bound' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://market.test/api/trusted-client/binding');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers).toEqual({ 'x-lobe-trust-token': 'client-id.signed' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
  });

  it('reports a client that is not bound to the tenant instance (403 CLIENT_TENANT_MISMATCH)', async () => {
    const result = await probeWith((async () =>
      json(403, refusal('CLIENT_TENANT_MISMATCH'))) as never);

    expect(result).toEqual({ code: 'CLIENT_TENANT_MISMATCH', status: 'unbound' });
  });

  it.each([
    [401, 'INVALID_TRUST_TOKEN'],
    [401, 'AUTH_REQUIRED'],
    [403, 'INSTANCE_FROZEN'],
    [403, 'INSTANCE_OFFLINE'],
  ])('reports a refusal with its own code (%s %s)', async (httpStatus, code) => {
    const result = await probeWith((async () => json(httpStatus, refusal(code))) as never);

    expect(result).toEqual({ code, httpStatus, status: 'refused' });
  });

  it('reports an instance that is not ready (503) as retryable, not as unbound', async () => {
    const result = await probeWith((async () =>
      json(503, refusal('INSTANCE_NOT_READY'), { 'retry-after': '1' })) as never);

    expect(result).toEqual({ code: 'INSTANCE_NOT_READY', status: 'not-ready' });
  });

  it('reports an unreachable Market (network error) without throwing', async () => {
    const result = await probeWith((async () => {
      throw new TypeError('fetch failed');
    }) as never);

    expect(result).toEqual({ status: 'unreachable' });
  });

  it('reports a timeout as unreachable', async () => {
    const result = await probeWith((async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as never);

    expect(result).toEqual({ status: 'unreachable' });
  });

  it.each([
    ['an HTML error page', new Response('<html>bad gateway</html>', { status: 502 })],
    ['an unknown JSON body', json(418, { teapot: true })],
    ['a 200 that does not say ready', json(200, { ready: false })],
  ])('does not take %s for a bound client', async (_label, response) => {
    const result = await probeWith((async () => response) as never);

    expect(result).toMatchObject({ status: 'refused' });
  });

  it('is skipped, without a request, when the trusted client is not configured', async () => {
    mocks.isTrustedClientEnabled.mockReturnValue(false);
    const fetchMock = vi.fn();

    const result = await probeWith(fetchMock as never);

    expect(result).toEqual({ status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a tenant id Market cannot take instead of sending a request', async () => {
    const { generateTrustedClientToken } = await import('@/libs/trusted-client');
    vi.mocked(generateTrustedClientToken).mockImplementationOnce(() => {
      throw Object.assign(new Error('MARKET_IDENTITY_UNAVAILABLE:TENANT_ID_UNSUPPORTED'), {
        code: 'TENANT_ID_UNSUPPORTED',
      });
    });
    const fetchMock = vi.fn();

    const result = await probeWith(fetchMock as never);

    expect(result).toEqual({ code: 'TENANT_ID_UNSUPPORTED', status: 'unsigned' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('probeMarketBindingForAllTenants', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once per tenant that is not bound, naming the tenant and the code, and stays quiet for bound ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.forEachTenant.mockImplementation(async (_job, operation) => {
      const results = [
        ['t-bound', { clientId: 'c', status: 'bound' }],
        ['t-unbound', { code: 'CLIENT_TENANT_MISMATCH', status: 'unbound' }],
        ['t-down', { status: 'unreachable' }],
      ] as const;
      for (const [tenantId, probe] of results) await operation(tenantId, probe);
      return { failed: [], succeeded: [] };
    });

    await probeMarketBindingForAllTenants({
      probe: async (tenantId) =>
        ({
          't-bound': { clientId: 'c', status: 'bound' },
          't-down': { status: 'unreachable' },
          't-unbound': { code: 'CLIENT_TENANT_MISMATCH', status: 'unbound' },
        })[tenantId as 't-bound'] as never,
    });

    const lines = warn.mock.calls.map((call) => call.join(' '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('t-unbound');
    expect(lines[0]).toContain('CLIENT_TENANT_MISMATCH');
    expect(lines[1]).toContain('t-down');
    expect(lines.join('\n')).not.toContain('t-bound');
  });
});
