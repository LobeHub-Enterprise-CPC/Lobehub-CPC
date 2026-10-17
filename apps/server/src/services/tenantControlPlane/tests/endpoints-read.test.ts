import { describe, expect, it, vi } from 'vitest';

import { TenantEndpointsService } from '../endpoints';

const updatedAt = new Date('2026-10-13T00:00:00Z');
const database = (row: unknown, endpoints: unknown[] = [], events: unknown[] = []) => {
  const query = (result: unknown) => {
    const chain: any = {};
    for (const method of ['from', 'leftJoin', 'where', 'orderBy', 'limit'])
      chain[method] = vi.fn(() => chain);
    // Drizzle queries are thenable; this mock preserves that database API boundary.
    // eslint-disable-next-line unicorn/no-thenable
    chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
    return chain;
  };
  const db: any = {
    select: vi
      .fn()
      .mockReturnValueOnce(query(row ? [row] : []))
      .mockReturnValueOnce(query(endpoints))
      .mockReturnValueOnce(query(events)),
  };
  db.transaction = (read: any) => read(db);
  return db;
};

describe('endpoint projection absence', () => {
  it('derives a stable default v0 only for a known tenant with no projection rows', async () => {
    const db = database({ slug: 'acme', updatedAt, state: null });
    const result = await new TenantEndpointsService(db, 'https://app.example.com').get('tenant-a');
    expect(result).toEqual({
      tenantId: 'tenant-a',
      acceptedVersion: 0,
      appliedVersion: 0,
      endpoints: [{ id: 'default', kind: 'default', host: null, active: true }],
      activeUrl: 'https://app.example.com/t/acme',
      observedAt: updatedAt.toISOString(),
    });
  });
  it('does not create a tenant from absence', async () => {
    await expect(new TenantEndpointsService(database(null)).get('missing')).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });
  it.each([
    { row: { slug: 'acme', updatedAt, state: null }, endpoints: [{ id: 'orphan' }] },
    { row: { slug: 'acme', updatedAt, state: { appliedVersion: 1 } }, endpoints: [] },
  ])('refuses inconsistent or damaged projection rows', async ({ row, endpoints }) => {
    await expect(
      new TenantEndpointsService(database(row, endpoints)).get('tenant-a'),
    ).rejects.toMatchObject({ code: 'ENDPOINTS_NOT_READY' });
  });
  it('preserves database failure instead of inventing a default endpoint', async () => {
    const failure = new Error('database unavailable');
    const db = { transaction: vi.fn().mockRejectedValue(failure) };
    await expect(new TenantEndpointsService(db as never).get('tenant-a')).rejects.toBe(failure);
  });
  it('does not reset a previously projected tenant when only its event history survives', async () => {
    const db = database(
      { slug: 'acme', updatedAt, state: null },
      [],
      [{ eventId: 'custom-applied' }],
    );
    await expect(new TenantEndpointsService(db).get('tenant-a')).rejects.toMatchObject({
      code: 'ENDPOINTS_NOT_READY',
    });
  });
});
