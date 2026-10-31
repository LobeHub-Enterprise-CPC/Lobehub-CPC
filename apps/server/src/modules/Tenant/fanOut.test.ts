// @vitest-environment node
import { currentTenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { forEachTenant, surveyTenants } from './fanOut';

const mocks = vi.hoisted(() => ({
  enterTenantId: vi.fn(),
  listAvailableTenantIds: vi.fn(),
  listTenantAvailability: vi.fn(),
}));

vi.mock('./postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));

vi.mock('./runtime', () => ({
  getTenantRuntime: () => mocks,
}));

// The global test setup replaces the gate with a pass-through; use the real one.
vi.mock('@/server/modules/Tenant/gate', async (importOriginal) => importOriginal());

describe('forEachTenant', () => {
  it('runs the job inside each available tenant and isolates failures', async () => {
    mocks.listAvailableTenantIds.mockResolvedValue(['t-a', 't-b', 't-c']);
    mocks.enterTenantId.mockImplementation(async (tenantId: string) => {
      if (tenantId === 't-b') throw Object.assign(new Error('frozen'), { code: 'TENANT_FROZEN' });
      return { release: async () => {}, scope: { session: {}, slug: tenantId, tenantId } };
    });

    const seen: (string | undefined)[] = [];
    const result = await forEachTenant('test', async (tenantId) => {
      seen.push(currentTenantScope()?.tenantId);
      if (tenantId === 't-c') throw new Error('boom');
      return tenantId.toUpperCase();
    });

    expect(seen).toEqual(['t-a', 't-c']);
    expect(result.succeeded).toEqual([{ result: 'T-A', tenantId: 't-a' }]);
    expect(result.failed).toEqual([
      { reason: 'TENANT_FROZEN', tenantId: 't-b' },
      { reason: 'Error', tenantId: 't-c' },
    ]);
    expect(currentTenantScope()).toBeUndefined();
  });

  it('surveys the whole directory from one read and reports refused tenants as skipped', async () => {
    mocks.enterTenantId.mockClear();
    mocks.listTenantAvailability.mockResolvedValue([
      { tenantId: 't-a' },
      { refusal: 'TENANT_FROZEN', tenantId: 't-b' },
      { tenantId: 't-c' },
    ]);
    mocks.enterTenantId.mockImplementation(async (tenantId: string) => {
      if (tenantId === 't-c')
        throw Object.assign(new Error('down'), { code: 'TENANT_UNAVAILABLE' });
      return { release: async () => {}, scope: { session: {}, slug: tenantId, tenantId } };
    });

    const result = await surveyTenants('test', async (tenantId) => tenantId.toUpperCase());

    expect(mocks.enterTenantId.mock.calls.map(([id]) => id)).toEqual(['t-a', 't-c']);
    expect(result).toEqual({
      directory: 3,
      failed: [{ reason: 'TENANT_UNAVAILABLE', tenantId: 't-c' }],
      skipped: [{ reason: 'TENANT_FROZEN', tenantId: 't-b' }],
      succeeded: [{ result: 'T-A', tenantId: 't-a' }],
    });
  });
});
