// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';

import { GET } from './route';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@lobechat/business-auth', () => ({
  listBusinessSSOProviders: mocks.list,
  managedBusinessSSO: true,
}));

describe('/webapi/auth/sso-providers', () => {
  it('answers a tenant refusal raised while listing providers with its code', async () => {
    mocks.list.mockRejectedValueOnce(
      new Error('Failed query', { cause: new TenantGateError('TENANT_EXPIRED') }),
    );

    const response = await GET();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'TENANT_EXPIRED' });
  });

  it('keeps other failures as an unavailable configuration', async () => {
    mocks.list.mockRejectedValueOnce(new Error('boom'));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'SSO_CONFIGURATION_UNAVAILABLE' });
  });
});
