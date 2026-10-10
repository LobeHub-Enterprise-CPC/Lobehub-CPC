// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/locales/requestLocale', () => ({ resolveRequestLocale: () => 'en-US' }));

const { default: worker } = await import('./app');

const env = () => ({
  ASSETS: {
    fetch: vi.fn(
      async () =>
        new Response('<html><head></head><body></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    ),
  },
  AUTH_API_BASE: 'https://api.example.com',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth worker', () => {
  it("loads the tenant's auth config for a page under /t/{slug}", async () => {
    const fetchMock = vi.fn(async () => Response.json({ config: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://auth.example.com/t/acme/signin'),
      env(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.example.com/t/acme/webapi/auth/spa-config',
    );
  });

  it('does not ask for a config without a tenant', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(new Request('https://auth.example.com/signin'), env());

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards tenant API calls with their prefix', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await worker.fetch(
      new Request('https://auth.example.com/t/acme/api/auth/get-session?x=1'),
      env(),
    );

    expect((fetchMock.mock.calls[0] as unknown as [Request])[0].url).toBe(
      'https://api.example.com/t/acme/api/auth/get-session?x=1',
    );
  });
});
