import { describe, expect, it } from 'vitest';

import { isTenantUnavailableCode, isTenantUnavailableResponse } from './tenantUnavailable';

describe('tenant unavailable codes', () => {
  it.each([
    'TENANT_DESTROYED',
    'TENANT_EXPIRED',
    'TENANT_FROZEN',
    'TENANT_NOT_FOUND',
    'TENANT_NOT_READY',
    'TENANT_OFFLINE',
  ])('treats %s as an unavailable workspace', (code) => {
    expect(isTenantUnavailableCode(code)).toBe(true);
  });

  it.each(['TENANT_MISMATCH', 'INVALID_EMAIL', '', undefined, null, 409])(
    'does not treat %s as an unavailable workspace',
    (code) => {
      expect(isTenantUnavailableCode(code)).toBe(false);
    },
  );

  it('recognizes the 409 TENANT_DESTROYED refusal of a late request', async () => {
    const response = Response.json({ code: 'TENANT_DESTROYED' }, { status: 409 });
    await expect(isTenantUnavailableResponse(response)).resolves.toBe(true);
  });

  it('ignores successful and unrelated failed responses', async () => {
    await expect(
      isTenantUnavailableResponse(Response.json({ code: 'TENANT_DESTROYED' })),
    ).resolves.toBe(false);
    await expect(
      isTenantUnavailableResponse(Response.json({ code: 'OTHER' }, { status: 409 })),
    ).resolves.toBe(false);
    await expect(isTenantUnavailableResponse(new Response('x', { status: 500 }))).resolves.toBe(
      false,
    );
  });
});
