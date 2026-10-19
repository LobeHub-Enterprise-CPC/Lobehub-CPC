import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeTenant, installTenantFetch, tenantRequestUrl } from '../client';

const location = {
  href: 'https://app.example.com/t/acme/agent',
  origin: 'https://app.example.com',
};

describe('tenantRequestUrl', () => {
  it.each([
    ['/trpc/lambda/user.get?batch=1', '/t/acme/trpc/lambda/user.get?batch=1'],
    ['/api/auth/get-session', '/t/acme/api/auth/get-session'],
    ['/webapi/chat/openai', '/t/acme/webapi/chat/openai'],
    ['https://app.example.com/api/auth/sign-in', 'https://app.example.com/t/acme/api/auth/sign-in'],
    ['/f/file-1', '/t/acme/f/file-1'],
    ['/market/agent/x', '/t/acme/market/agent/x'],
    ['/api', '/t/acme/api'],
  ])('prefixes backend call %s', (input, expected) => {
    expect(tenantRequestUrl(input, 'acme', location)).toBe(expected);
  });

  it.each([
    ['/t/acme/trpc/x'],
    ['/agent/123'],
    ['/apiary'],
    ['/market-auth-callback'],
    ['/fonts/a.woff'],
    ['https://cdn.example.com/api/x'],
  ])('leaves %s unchanged', (input) => {
    expect(tenantRequestUrl(input, 'acme', location)).toBeNull();
  });

  it('does nothing without a tenant', () => {
    expect(tenantRequestUrl('/trpc/x', null, location)).toBeNull();
  });
});

describe('installTenantFetch', () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    window.fetch = originalFetch;
    window.history.replaceState(null, '', '/');
    initializeTenant(new URL(window.location.href));
  });

  it('sends same-origin backend calls under the tenant of the page', async () => {
    window.history.replaceState(null, '', '/t/acme/agent');
    initializeTenant(new URL(window.location.href));
    const fetchMock = vi.fn(async () => new Response('ok'));
    window.fetch = fetchMock as typeof fetch;

    installTenantFetch(window as Window & typeof globalThis);
    await window.fetch('/trpc/lambda/x', { method: 'POST' });
    await window.fetch('/images/logo.png');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/t/acme/trpc/lambda/x', { method: 'POST' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/images/logo.png', undefined);
  });

  it('leaves fetch alone on a page without a tenant', () => {
    window.history.replaceState(null, '', '/agent');
    initializeTenant(new URL(window.location.href));
    const fetchMock = vi.fn();
    window.fetch = fetchMock as unknown as typeof fetch;

    installTenantFetch(window as Window & typeof globalThis);

    expect(window.fetch).toBe(fetchMock);
  });
});

describe('installTenantFetch endpoint change', () => {
  const origin = 'https://app.example.com';
  const changed = () =>
    new Response(
      JSON.stringify({ code: 'TENANT_ENDPOINT_CHANGED', activeUrl: 'https://evil.test' }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 409,
      },
    );

  const setup = (
    pathname: string,
    respond: () => Response,
    bootstrap?: Parameters<typeof initializeTenant>[1],
  ) => {
    const store = new Map<string, string>();
    const win = {
      fetch: vi.fn(async () => respond()),
      location: {
        assign: vi.fn(),
        href: `${origin}${pathname}`,
        origin,
        pathname,
      },
      sessionStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    };
    const original = win.fetch;
    initializeTenant(new URL(win.location.href), bootstrap);
    installTenantFetch(win as unknown as Window & typeof globalThis);
    return Object.assign(win, { original });
  };

  afterEach(() => initializeTenant(new URL('https://app.example.com/')));

  it('re-resolves the tenant root once when a backend call reports the endpoint changed', async () => {
    const win = setup('/t/acme/agent', changed);

    const [first, second] = await Promise.all([
      win.fetch('/trpc/lambda/a'),
      win.fetch('/trpc/lambda/b'),
    ]);

    expect(win.location.assign).toHaveBeenCalledTimes(1);
    // Never the address the response names: the server re-resolves the tenant itself.
    expect(win.location.assign).toHaveBeenCalledWith(`${origin}/t/acme`);
    // The caller still reads the response it got.
    expect(first.status).toBe(409);
    expect((await second.json()).code).toBe('TENANT_ENDPOINT_CHANGED');
  });

  it('does not loop when the root keeps answering that the endpoint changed', async () => {
    const win = setup('/t/acme/agent', changed);
    await win.fetch('/trpc/lambda/a');
    await win.fetch('/trpc/lambda/b');
    expect(win.location.assign).toHaveBeenCalledTimes(1);
  });

  it('leaves other 409 responses alone', async () => {
    const win = setup(
      '/t/acme/agent',
      () => new Response(JSON.stringify({ code: 'CONFLICT' }), { status: 409 }),
    );
    await win.fetch('/trpc/lambda/a');
    expect(win.location.assign).not.toHaveBeenCalled();
  });

  it('also watches a custom authority, which needs no path prefix', async () => {
    const win = setup('/agent', changed, { basePath: '', slug: 'acme' });
    await win.fetch('/trpc/lambda/a');
    expect(win.original).toHaveBeenCalledWith('/trpc/lambda/a', undefined);
    expect(win.location.assign).toHaveBeenCalledWith(`${origin}/`);
  });

  it('watches XMLHttpRequest answers too', () => {
    class FakeXhr {
      status = 409;
      responseType = '';
      responseText = JSON.stringify({ code: 'TENANT_ENDPOINT_CHANGED' });
      listeners: Array<() => void> = [];
      addEventListener(_: string, listener: () => void) {
        this.listeners.push(listener);
      }
      open() {}
    }
    const win = setup('/t/acme/agent', changed);
    Object.assign(win, { XMLHttpRequest: FakeXhr });
    installTenantFetch(win as unknown as Window & typeof globalThis);
    const xhr = new FakeXhr();
    // The patched `open` registers the listener on the instance it opens.
    (xhr.open as (method: string, url: string) => void)('GET', '/trpc/x');
    xhr.listeners.forEach((listener) => listener());
    expect(win.location.assign).toHaveBeenCalledWith(`${origin}/t/acme`);
  });
});
