import { initializeTenant } from '@lobechat/business-tenant/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTenantFetch, tenantRequestUrl } from '../tenantFetch';

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
  ])('prefixes backend call %s', (input, expected) => {
    expect(tenantRequestUrl(input, 'acme', location)).toBe(expected);
  });

  it.each([['/t/acme/trpc/x'], ['/agent/123'], ['/apiary'], ['https://cdn.example.com/api/x']])(
    'leaves %s unchanged',
    (input) => {
      expect(tenantRequestUrl(input, 'acme', location)).toBeNull();
    },
  );

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
