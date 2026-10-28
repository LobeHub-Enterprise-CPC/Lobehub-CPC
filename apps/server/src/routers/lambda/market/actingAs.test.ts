// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { actAsInput, assertNoOrganizationScopeInTenant } from './actingAs';

const inTenant = <T>(fn: () => T) =>
  runWithTenantScope(
    { session: {}, slug: 'a', tenantId: 'tenant-a' } as unknown as TenantScope,
    fn,
  );

// R13: a tenant closes acting-as-organization. Market refuses the header; CPC
// refuses first, loudly, instead of dropping it and publishing as the person.
describe('actAsInput', () => {
  it('accepts an absent actAs everywhere', () => {
    expect(actAsInput.safeParse(undefined).success).toBe(true);
    expect(inTenant(() => actAsInput.safeParse(undefined).success)).toBe(true);
  });

  it('keeps accepting an organization account id outside a tenant', () => {
    expect(actAsInput.parse(321)).toBe(321);
  });

  it('rejects any actAs inside a tenant with an explicit message', () => {
    const result = inTenant(() => actAsInput.safeParse(321));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      'MARKET_ACTING_AS_ORGANIZATION_UNAVAILABLE',
    );
  });

  it('still validates the shape outside a tenant', () => {
    expect(actAsInput.safeParse(-1).success).toBe(false);
    expect(actAsInput.safeParse(1.5).success).toBe(false);
  });
});

describe('assertNoOrganizationScopeInTenant', () => {
  it('lets a personal request through in a tenant', () => {
    expect(() => inTenant(() => assertNoOrganizationScopeInTenant(undefined))).not.toThrow();
  });

  it('refuses an organization workspace scope in a tenant instead of falling back to personal', () => {
    let error: unknown;
    try {
      inTenant(() => assertNoOrganizationScopeInTenant('wsp_1'));
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
    expect((error as TRPCError).message).toContain('MARKET_ACTING_AS_ORGANIZATION_UNAVAILABLE');
  });

  it('keeps the workspace scope outside a tenant', () => {
    expect(() => assertNoOrganizationScopeInTenant('wsp_1')).not.toThrow();
  });
});
