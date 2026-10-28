import { generateKeyPairSync } from 'node:crypto';

import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { calculateJwkThumbprint, decodeProtectedHeader, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { authEnvMock } = vi.hoisted(() => ({
  authEnvMock: {
    INTERNAL_JWT_EXPIRATION: '30s',
    JWKS_KEY: '',
  },
}));

vi.mock('@/envs/auth', () => ({ authEnv: authEnvMock }));

const createRsaKey = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  return {
    kid,
    privateJwk: {
      ...privateKey.export({ format: 'jwk' }),
      alg: 'RS256',
      kid,
      use: 'sig',
    },
    privateKey,
    publicJwk: {
      ...publicKey.export({ format: 'jwk' }),
      alg: 'RS256',
      kid,
      use: 'sig',
    },
  };
};

describe('internal JWT key rotation', () => {
  const keys = {
    new: createRsaKey('new-key'),
    old: createRsaKey('old-key'),
  };

  beforeAll(() => {
    authEnvMock.JWKS_KEY = JSON.stringify({ keys: [keys.old.privateJwk, keys.new.privateJwk] });
  });

  const signToken = (key: (typeof keys)[keyof typeof keys], kid: string | null = key.kid) =>
    new SignJWT({ purpose: 'lobe-internal-call', tid: 'tenant-a' })
      .setProtectedHeader(kid === null ? { alg: 'RS256' } : { alg: 'RS256', kid })
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key.privateKey);

  const signHeteroToken = (key: (typeof keys)[keyof typeof keys], kid: string | null = key.kid) =>
    new SignJWT({
      capabilities: ['hetero:finish'],
      operation_id: 'operation-1',
      purpose: 'hetero-operation',
      tid: 'tenant-a',
    })
      .setProtectedHeader(kid === null ? { alg: 'RS256' } : { alg: 'RS256', kid })
      .setIssuer('urn:lobehub:internal')
      .setAudience('urn:lobehub:hetero-operation')
      .setSubject('user-1')
      .setJti('jwt-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key.privateKey);

  const inTenant = <T>(tenantId: string, operation: () => Promise<T>) =>
    runWithTenantScope({ slug: tenantId, tenantId } as TenantScope, operation);

  it.each(['old', 'new'] as const)('verifies a token signed with the %s key', async (name) => {
    const { validateInternalJWT } = await import('./internalJwt');

    const token = await signToken(keys[name]);
    await expect(inTenant('tenant-a', () => validateInternalJWT(token))).resolves.toEqual({
      userId: 'user-1',
    });
  });

  it.each(['old', 'new'] as const)(
    'verifies a hetero operation token signed with the %s key',
    async (name) => {
      const { validateHeteroOperationJWT } = await import('./internalJwt');

      const token = await signHeteroToken(keys[name]);
      await expect(
        inTenant('tenant-a', () => validateHeteroOperationJWT(token)),
      ).resolves.toMatchObject({
        operation_id: 'operation-1',
        sub: 'user-1',
      });
    },
  );

  it('uses the first RS256 private key for signing', async () => {
    const { signInternalJWT } = await import('./internalJwt');

    authEnvMock.JWKS_KEY = JSON.stringify({ keys: [keys.old.privateJwk, keys.new.privateJwk] });
    expect(
      decodeProtectedHeader(await inTenant('tenant-a', () => signInternalJWT('user-1'))).kid,
    ).toBe('old-key');

    authEnvMock.JWKS_KEY = JSON.stringify({ keys: [keys.new.privateJwk, keys.old.privateJwk] });
    expect(
      decodeProtectedHeader(await inTenant('tenant-a', () => signInternalJWT('user-1'))).kid,
    ).toBe('new-key');
  });

  it('derives a stable kid for a legacy key that omits one', async () => {
    const { signInternalJWT, validateInternalJWT } = await import('./internalJwt');
    const { kid: _kid, ...legacyPrivateJwk } = keys.old.privateJwk;
    const expectedKid = await calculateJwkThumbprint(legacyPrivateJwk);

    authEnvMock.JWKS_KEY = JSON.stringify({ keys: [legacyPrivateJwk] });
    const token = await inTenant('tenant-a', () => signInternalJWT('user-1'));

    expect(decodeProtectedHeader(token).kid).toBe(expectedKid);
    await expect(inTenant('tenant-a', () => validateInternalJWT(token))).resolves.toEqual({
      userId: 'user-1',
    });

    authEnvMock.JWKS_KEY = JSON.stringify({ keys: [keys.old.privateJwk, keys.new.privateJwk] });
  });

  it('verifies in-flight tokens without kid after a second key is added', async () => {
    const { validateHeteroOperationJWT, validateInternalJWT } = await import('./internalJwt');

    authEnvMock.JWKS_KEY = JSON.stringify({ keys: [keys.old.privateJwk, keys.new.privateJwk] });

    const token = await signToken(keys.old, null);
    await expect(inTenant('tenant-a', () => validateInternalJWT(token))).resolves.toEqual({
      userId: 'user-1',
    });
    const heteroToken = await signHeteroToken(keys.old, null);
    await expect(
      inTenant('tenant-a', () => validateHeteroOperationJWT(heteroToken)),
    ).resolves.toMatchObject({ operation_id: 'operation-1', sub: 'user-1' });
  });
});
