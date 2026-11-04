import type { TenantScope } from '@lobechat/database/tenant/requestScope';
import { runWithTenantScope } from '@lobechat/database/tenant/requestScope';
import { describe, expect, it, vi } from 'vitest';

import { honoApp } from './app';

// The docs routes are public and independent of the business routes and auth
// layers, which need the whole server to load.
vi.mock('./routes', () => ({ default: {} }));
vi.mock('./middleware/auth', () => ({
  userAuthMiddleware: (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('./middleware/workspace', () => ({
  workspaceAuthMiddleware: (_c: unknown, next: () => unknown) => next(),
}));

const tenantScope = (publicUrl: string) =>
  ({
    acceptedVersion: 1,
    endpoint: { basePath: '/orgs/acme', publicUrl, version: 1 },
    slug: 'acme',
    tenantId: 'tenant-acme',
  }) as unknown as TenantScope;

const getSpec = async () => (await honoApp.request('/api/v1/openapi.json')).json();

describe('API docs under a tenant', () => {
  it('loads the spec relative to the address the docs were opened at', async () => {
    const html = await (await honoApp.request('/api/v1/docs')).text();
    const specUrl = html.match(/&quot;url&quot;:&quot;([^&]+)&quot;|"url":\s*"([^"]+)"/);
    const url = specUrl?.[1] ?? specUrl?.[2];

    expect(url).toBe('openapi.json');
    // The proxy strips the prefix before the route runs, but the browser
    // resolves the spec against the tenant address it actually loaded.
    expect(new URL(url!, 'https://app.example.com/orgs/acme/api/v1/docs').pathname).toBe(
      '/orgs/acme/api/v1/openapi.json',
    );
    expect(new URL(url!, 'https://acme.example.com/api/v1/docs').pathname).toBe(
      '/api/v1/openapi.json',
    );
  });

  it("names the tenant's public entry as the server", async () => {
    const spec = await runWithTenantScope(
      tenantScope('https://app.example.com/orgs/acme/'),
      getSpec,
    );

    expect(spec.servers).toHaveLength(1);
    expect(spec.servers[0].url).toBe('https://app.example.com/orgs/acme');
    expect(spec.servers[0].description).toEqual(expect.any(String));
  });

  it('keeps the deployment server outside a tenant and does not leak one tenant into the cache', async () => {
    await runWithTenantScope(tenantScope('https://acme.example.com'), getSpec);
    const spec = await getSpec();

    expect(spec.servers).toHaveLength(1);
    expect(spec.servers[0].url).not.toContain('acme');
  });
});
