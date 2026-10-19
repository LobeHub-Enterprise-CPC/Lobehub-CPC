import { createDecipheriv, createHash } from 'node:crypto';

import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import contract from './__fixtures__/trust-token-kid.contract.json';

// Cross-repo contract with Market: the same fixture file is asserted in Market
// (src/libs/trusted-client/__tests__/index.test.ts) against its parser and validator. Here the
// real SDK signer is used (nothing is mocked but the environment).
const { appEnv } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: undefined as string | undefined,
    MARKET_TRUSTED_CLIENT_SECRET: undefined as string | undefined,
  },
}));

vi.mock('@/envs/app', () => ({ appEnv }));

const { generateTrustedClientToken } = await import('./index');

/** The format in the fixture description: `<kid>.<base64(IV[12] + ciphertext + tag[16])>`. */
const openToken = (token: string, secret: string) => {
  const separator = token.lastIndexOf('.');
  const data = Buffer.from(token.slice(separator + 1), 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(secret).digest(),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(-16));

  return {
    kid: token.slice(0, separator),
    payload: JSON.parse(decipher.update(data.subarray(12, -16)) + decipher.final('utf8')),
  };
};

describe('trust token contract fixture', () => {
  beforeEach(() => {
    appEnv.MARKET_TRUSTED_CLIENT_ID = contract.kid;
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = contract.secret;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(contract.issuedAt);
  });
  afterEach(() => vi.useRealTimers());

  it('reads the fixed token the way Market documents it', () => {
    const { kid, payload } = openToken(contract.token, contract.secret);

    expect(kid).toBe(contract.kid);
    expect(payload).toEqual(contract.payload);
    expect(payload.clientId).toBe(kid);
  });

  it('signs the same shape the fixed token has', () => {
    const token = runWithTenantScope(
      {
        session: {},
        slug: 'contract',
        tenantId: contract.payload.tenantId,
      } as unknown as TenantScope,
      () =>
        generateTrustedClientToken({
          email: contract.payload.email,
          name: contract.payload.name,
          userId: contract.payload.userId,
        }),
    );

    expect(token).toMatch(new RegExp(`^${contract.kid}\\.[A-Za-z0-9+/]+=*$`));
    const { kid, payload } = openToken(token!, contract.secret);
    expect(kid).toBe(contract.kid);
    // Only the nonce is random; every other claim is fixed by the inputs and the clock.
    expect(payload.nonce).toMatch(/^[\da-f]{8}$/);
    expect({ ...payload, nonce: contract.payload.nonce }).toEqual(contract.payload);
    // The IV is random per token, so a second token differs while keeping the same kid.
    expect(token).not.toBe(contract.token);
    expect(token!.slice(0, token!.lastIndexOf('.'))).toBe(contract.token.split('.')[0]);
  });
});

describe('trust token tenantId contract', () => {
  beforeEach(() => {
    appEnv.MARKET_TRUSTED_CLIENT_ID = contract.kid;
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = contract.secret;
  });
  const sign = (tenantId: string) =>
    runWithTenantScope({ session: {}, slug: 'x', tenantId } as unknown as TenantScope, () =>
      generateTrustedClientToken({ email: 'a@example.test', userId: 'user-1' }),
    );

  it.each(contract.tenantId.accepted)('signs for the UUID tenant %s', (tenantId) => {
    expect(openToken(sign(tenantId)!, contract.secret).payload.tenantId).toBe(tenantId);
  });

  it.each(contract.tenantId.rejected)('refuses to sign for the non-UUID tenant %j', (tenantId) => {
    expect(() => sign(tenantId)).toThrowError(
      expect.objectContaining({
        code: expect.stringMatching(/^TENANT_(ID_UNSUPPORTED|REQUIRED)$/),
      }),
    );
  });
});
