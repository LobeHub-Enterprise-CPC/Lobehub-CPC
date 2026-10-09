// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it } from 'vitest';

import { logicalObjectKey, tenantObjectKey } from './tenantKey';

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: 'acme', tenantId } as unknown as TenantScope, fn);

describe('tenant object keys', () => {
  it('stores every object under the current tenant root', () => {
    expect(inTenant('tenant-1', () => tenantObjectKey('files/2026/a.png'))).toBe(
      't/tenant-1/files/2026/a.png',
    );
    expect(inTenant('tenant-1', () => tenantObjectKey('/files/a.png'))).toBe(
      't/tenant-1/files/a.png',
    );
  });

  it('never lets a key address another tenant', () => {
    expect(inTenant('tenant-1', () => tenantObjectKey('t/tenant-2/files/a.png'))).toBe(
      't/tenant-1/t/tenant-2/files/a.png',
    );
  });

  it('refuses storage access outside a tenant', () => {
    expect(() => tenantObjectKey('files/a.png')).toThrow(/TENANT_REQUIRED/);
  });

  it('reads back only keys of the current tenant', () => {
    expect(inTenant('tenant-1', () => logicalObjectKey('t/tenant-1/files/a.png'))).toBe(
      'files/a.png',
    );
    expect(inTenant('tenant-1', () => logicalObjectKey('t/tenant-2/files/a.png'))).toBeNull();
    expect(inTenant('tenant-1', () => logicalObjectKey('files/a.png'))).toBeNull();
  });
});
