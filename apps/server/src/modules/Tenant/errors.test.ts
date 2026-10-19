// @vitest-environment node
import { TenantDatabaseError } from '@lobechat/database/tenant';
import { describe, expect, it } from 'vitest';

import { TenantGateError, tenantGateErrorOf, tenantRefusalResponse } from './errors';
import { TenantRoutingUnavailableError } from './routingErrors';

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
  it('keeps routing diagnostics internal when returning a wrapped unavailable refusal', async () => {
    const response = tenantRefusalResponse(
      wrapped(new TenantRoutingUnavailableError('ROUTING_LOAD_EXPIRED')),
    )!;
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({ code: 'TENANT_UNAVAILABLE' });
  });
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

describe('TenantGateError.source', () => {
  it.each(['TENANT_EXPIRED', 'TENANT_FROZEN', 'TENANT_OFFLINE'] as const)(
    'marks the lifecycle refusal %s as an admission refusal by default',
    (code) => {
      expect(new TenantGateError(code).source).toBe('admission');
    },
  );

  it.each(['TENANT_NOT_READY', 'TENANT_UNAVAILABLE'] as const)(
    'treats %s as an infrastructure failure unless the raiser says it is an admission refusal',
    (code) => {
      expect(new TenantGateError(code).source).toBe('infrastructure');
      expect(new TenantGateError(code, undefined, { source: 'admission' }).source).toBe(
        'admission',
      );
    },
  );

  it('keeps the marker, the code and the status of the wrapped refusal the callers already see', () => {
    const refusal = new TenantGateError('TENANT_NOT_READY', undefined, {
      cause: new Error('db'),
      source: 'admission',
    });
    expect(refusal.code).toBe('TENANT_NOT_READY');
    expect(refusal.status).toBe(503);
    expect(refusal.cause).toBeInstanceOf(Error);
  });

  it('marks a tenant database failure as infrastructure when it is lifted into a gate refusal', () => {
    expect(
      tenantGateErrorOf(wrapped(new TenantDatabaseError('TENANT_NOT_READY', 'schema-name-invalid')))
        ?.source,
    ).toBe('infrastructure');
  });
});
