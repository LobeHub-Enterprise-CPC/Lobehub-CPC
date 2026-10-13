// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { getTenantPageBootstrap } from '../pageBootstrap';
import { signTenantRoute, TENANT_ROUTE_HEADER } from '../routeHeader';

const mocks = vi.hoisted(() => ({ activeUrl: 'https://chat.example.com', findSlug: vi.fn() }));
vi.mock('../endpoints', () => ({ findSlugEndpoint: mocks.findSlug }));
process.env.KEY_VAULTS_SECRET = 'bootstrap-test-secret';
describe('trusted same-origin SPA bootstrap', () => {
  it('never bootstraps a tenant from an unsigned header or arbitrary URL path', async () => {
    expect(
      await getTenantPageBootstrap(
        new Request('https://evil.example.com/t/acme/signin', {
          headers: { [TENANT_ROUTE_HEADER]: 'acme.forged' },
        }),
      ),
    ).toBeUndefined();
    expect(mocks.findSlug).not.toHaveBeenCalled();
  });
  it.each(['https://chat.example.com', 'https://app.example.com/t/acme'])(
    'derives basePath and issuer source from the authoritative active URL %s',
    async (activeUrl) => {
      mocks.findSlug.mockResolvedValue({ slug: 'acme', state: { activeUrl, appliedVersion: 2 } });
      const request = new Request('http://internal/spa-auth/en-US/signin', {
        headers: { [TENANT_ROUTE_HEADER]: signTenantRoute('acme')! },
      });
      expect(await getTenantPageBootstrap(request)).toEqual({
        slug: 'acme',
        publicUrl: activeUrl,
        version: 2,
        basePath: activeUrl.endsWith('/t/acme') ? '/t/acme' : '',
      });
    },
  );
});
