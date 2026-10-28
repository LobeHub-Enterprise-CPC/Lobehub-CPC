import { describe, expect, it } from 'vitest';

import { E2E_TENANT, tenantClientConfig, tenantPath } from './tenant';

describe('E2E tenant addressing', () => {
  it('addresses pages and auth endpoints inside the same tenant', () => {
    expect(tenantPath('/')).toBe('/t/e2e');
    expect(tenantPath('/api/auth/sign-in/email')).toBe('/t/e2e/api/auth/sign-in/email');
    expect(tenantPath('/page?sort=updated')).toBe('/t/e2e/page?sort=updated');
    expect(tenantPath('/t/e2e/page')).toBe('/t/e2e/page');
    expect(tenantPath('https://example.com/callback')).toBe('https://example.com/callback');
  });

  it('pins SQL fixtures to the tenant schema without a public fallback', () => {
    const config = tenantClientConfig('postgresql://example.test/e2e');
    expect(config.connectionString).toBe('postgresql://example.test/e2e');
    expect(config.options).toMatch(/^-c search_path=tenant_[a-f0-9]{24},extensions,paradedb$/);
    expect(E2E_TENANT.id).toMatch(/^e2e-/);
  });
});
