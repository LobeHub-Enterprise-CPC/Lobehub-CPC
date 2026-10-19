// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTrustedClientTokenForSession } = vi.hoisted(() => ({
  getTrustedClientTokenForSession: vi.fn(),
}));

vi.mock('@/libs/trusted-client', () => ({ getTrustedClientTokenForSession }));
vi.mock('@/server/modules/Tenant/gate', () => ({
  withTenantRequest: (handler: unknown) => handler,
}));
vi.mock('@/server/services/market', () => ({
  MarketService: class {
    market = { auth: { getUserInfo: vi.fn() } };
  },
}));

const { POST } = await import('./route');

const userinfo = () =>
  POST(
    new NextRequest('https://work.example.com/t/acme/market/oidc/userinfo', {
      body: JSON.stringify({}),
      method: 'POST',
    }),
    { params: Promise.resolve({ segments: ['userinfo'] }) },
  );

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  getTrustedClientTokenForSession.mockResolvedValue('client-id.signed-token');
});

describe('market oidc userinfo proxy with the trusted client', () => {
  it('sends the trust token, which already names the signing client, and no other trust header', async () => {
    fetchMock.mockResolvedValue(Response.json({ sub: 'user_1' }));

    const response = await userinfo();

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-lobe-trust-token': 'client-id.signed-token',
    });
  });

  it('asks for a token before it calls Market, and answers 400 when there is none', async () => {
    getTrustedClientTokenForSession.mockResolvedValue(undefined);

    const response = await userinfo();

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])(
    'passes Market status %s on instead of masking it as 500',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('{}', { headers: { 'Retry-After': '7' }, status }));

      const response = await userinfo();

      expect(response.status).toBe(status);
      if (status === 429) expect(response.headers.get('Retry-After')).toBe('7');
    },
  );

  it('answers 502 when Market cannot be reached, and bounds the wait', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await userinfo();

    expect(response.status).toBe(502);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    errorSpy.mockRestore();
  });

  it('keeps 500 for any other Market failure', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await userinfo()).status).toBe(500);
    errorSpy.mockRestore();
  });
});
