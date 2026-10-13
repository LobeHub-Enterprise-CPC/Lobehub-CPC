// @vitest-environment node
import { TenantDatabaseError } from '@lobechat/database/tenant';
import { describe, expect, it } from 'vitest';

import { TenantGateError, tenantGateErrorOf, tenantRefusalResponse } from '../errors';

const wrapped = (cause: unknown) => new Error('Failed query', { cause });

describe('tenantGateErrorOf', () => {
  it('finds a lifecycle refusal raised inside the database driver', () => {
    const refusal = new TenantGateError('TENANT_OFFLINE');

    expect(tenantGateErrorOf(wrapped(refusal))).toBe(refusal);
  });

  it('treats a tenant database refusal as the gate refusal with the same code', () => {
    const refusal = tenantGateErrorOf(
      wrapped(new TenantDatabaseError('TENANT_UNAVAILABLE', 'pool-closed')),
    );

    expect(refusal).toBeInstanceOf(TenantGateError);
    expect(refusal?.code).toBe('TENANT_UNAVAILABLE');
  });

  it('ignores errors that are not tenant refusals', () => {
    expect(tenantGateErrorOf(wrapped(new Error('boom')))).toBeUndefined();
  });
});

describe('tenantRefusalResponse', () => {
  it.each([
    ['TENANT_EXPIRED', 403],
    ['TENANT_FROZEN', 403],
    ['TENANT_NOT_READY', 503],
    ['TENANT_OFFLINE', 403],
  ] as const)('answers %s with its code and status', async (code, status) => {
    const response = tenantRefusalResponse(wrapped(new TenantGateError(code)))!;

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ code });
  });

  it('keeps the freeze reasons', async () => {
    const response = tenantRefusalResponse(
      new TenantGateError('TENANT_FROZEN', { freezeReasons: ['manual'] }),
    )!;

    await expect(response.json()).resolves.toEqual({ code: 'TENANT_FROZEN', reasons: ['manual'] });
  });

  it('returns nothing for other failures', () => {
    expect(tenantRefusalResponse(new Error('boom'))).toBeUndefined();
  });
});
