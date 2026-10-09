// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { getServerDB } from '../core/db-adaptor';
import type { LobeChatDatabase } from '../type';
import { TenantDatabaseError } from './errors';
import { currentTenantScope, runWithTenantScope, tenantDB, type TenantScope } from './requestScope';

const scopeFor = (tenantId: string): TenantScope => {
  const database = { marker: tenantId, query: () => tenantId } as unknown as LobeChatDatabase;
  return {
    session: { database, run: async () => undefined, schemaName: `tenant_${tenantId}`, tenantId },
    slug: tenantId,
    tenantId,
  } as unknown as TenantScope;
};

describe('tenantDB', () => {
  it('fails closed with TENANT_REQUIRED outside a tenant scope', () => {
    expect(() => (tenantDB as any).query).toThrow(TenantDatabaseError);
    expect(currentTenantScope()).toBeUndefined();
  });

  it('can be awaited outside a scope without resolving the tenant', async () => {
    await expect(getServerDB()).resolves.toBe(tenantDB);
  });

  it('follows the scope it is used in', async () => {
    const read = () => (tenantDB as any).query();

    const [a, b] = await Promise.all([
      runWithTenantScope(scopeFor('tenant-a'), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return read();
      }),
      runWithTenantScope(scopeFor('tenant-b'), async () => read()),
    ]);

    expect(a).toBe('tenant-a');
    expect(b).toBe('tenant-b');
  });
});
