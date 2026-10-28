// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { getTenantPageBootstrap } from './pageBootstrap';
import { signTenantRoute, TENANT_ROUTE_HEADER } from './routeHeader';

const mocks = vi.hoisted(() => ({ findSlug: vi.fn() }));
vi.mock('./endpoints', () => ({ findSlugEndpoint: mocks.findSlug }));
process.env.KEY_VAULTS_SECRET = 'bootstrap-test-secret';
describe('trusted same-origin SPA bootstrap', () => {
  it('never bootstraps a tenant from an unsigned header or arbitrary URL path', async () => {
    expect(
      await getTenantPageBootstrap(
        new Request('https://evil.example.com/orgs/acme/signin', {
          headers: { [TENANT_ROUTE_HEADER]: 'acme.forged' },
        }),
      ),
    ).toBeUndefined();
    expect(mocks.findSlug).not.toHaveBeenCalled();
  });
  it.each(['https://chat.example.com', 'https://app.example.com/orgs/acme'])(
    'derives basePath and issuer source from the authoritative active URL %s',
    async (activeUrl) => {
      mocks.findSlug.mockResolvedValue({
        name: 'Acme Inc.',
        slug: 'acme',
        tenantId: 'tenant-1',
        state: { activeUrl, appliedVersion: 2 },
      });
      const request = new Request('http://internal/spa-auth/en-US/signin', {
        headers: { [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! },
      });
      expect(await getTenantPageBootstrap(request)).toEqual({
        name: 'Acme Inc.',
        slug: 'acme',
        publicUrl: activeUrl,
        version: 2,
        basePath: activeUrl.endsWith('/orgs/acme') ? '/orgs/acme' : '',
      });
    },
  );

  it('omits the display name instead of sending an empty one', async () => {
    mocks.findSlug.mockResolvedValue({
      name: '',
      slug: 'acme',
      tenantId: 'tenant-1',
      state: { activeUrl: 'https://app.example.com/orgs/acme', appliedVersion: 2 },
    });
    const request = new Request('http://internal/spa-auth/en-US/signin', {
      headers: { [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! },
    });
    expect(await getTenantPageBootstrap(request)).not.toHaveProperty('name');
  });
});
