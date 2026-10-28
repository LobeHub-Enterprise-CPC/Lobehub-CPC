import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { validateOIDCJWT } from '@/libs/oidc-provider/jwt';

import {
  signHeteroOperationJWT,
  signInternalJWT,
  signTunnelAccessToken,
  signUserJWT,
  signWorkspaceDeviceToken,
  validateHeteroOperationClaims,
  validateHeteroOperationJWT,
  validateInternalJWT,
} from '../internalJwt';

const { mockAuthEnv } = vi.hoisted(() => ({
  mockAuthEnv: { ENABLE_OIDC: true, INTERNAL_JWT_EXPIRATION: '1m', JWKS_KEY: '' },
}));

vi.mock('@/envs/auth', () => ({ authEnv: mockAuthEnv }));
// Orthogonal to tenant binding: whether the issuing client is still registered (jwt.test.ts).
vi.mock('@/server/services/oidc/oidcProvider', () => ({
  getOIDCProvider: async () => ({ Client: { find: async (clientId: string) => ({ clientId }) } }),
}));

// Real keys and real jose: tenant binding is a property of the signed token,
// so the signature path must not be mocked.
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let kid: string;

beforeAll(async () => {
  ({ privateKey } = await generateKeyPair('RS256', { extractable: true }));
  kid = 'tenant-test-kid';
  mockAuthEnv.JWKS_KEY = JSON.stringify({
    keys: [{ ...(await exportJWK(privateKey)), alg: 'RS256', kid, use: 'sig' }],
  });
});

const inTenant = <T>(tenantId: string, operation: () => Promise<T>) =>
  runWithTenantScope({ slug: tenantId, tenantId } as TenantScope, operation);

/** Shaped like an oidc-provider JWT access token (iss/aud/client_id/scope + tid claim). */
const signProviderAccessToken = (claims: Record<string, unknown>) =>
  new SignJWT({ client_id: 'cli', scope: 'openid', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject('user-1')
    .setAudience('urn:lobehub:chat')
    .setIssuer('http://localhost:3000/t/tenant-a/oidc')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

describe('OIDC access token tenant binding', () => {
  it('accepts a token issued for the current tenant', async () => {
    const token = await signProviderAccessToken({ tid: 'tenant-a' });

    await expect(inTenant('tenant-a', () => validateOIDCJWT(token))).resolves.toMatchObject({
      userId: 'user-1',
    });
  });

  it('rejects a token issued for another tenant', async () => {
    const token = await signProviderAccessToken({ tid: 'tenant-a' });

    await expect(inTenant('tenant-b', () => validateOIDCJWT(token))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects a token without a tenant claim', async () => {
    const token = await signProviderAccessToken({});

    await expect(inTenant('tenant-a', () => validateOIDCJWT(token))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects a non-string tenant claim', async () => {
    const token = await signProviderAccessToken({ tid: ['tenant-a'] });

    await expect(inTenant('tenant-a', () => validateOIDCJWT(token))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('applies to the cli-sandbox user token as well', async () => {
    const token = await inTenant('tenant-a', () => signUserJWT('user-1'));

    await expect(inTenant('tenant-a', () => validateOIDCJWT(token))).resolves.toMatchObject({
      userId: 'user-1',
    });
    await expect(inTenant('tenant-b', () => validateOIDCJWT(token))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('hetero operation JWT tenant binding', () => {
  const sign = () =>
    signHeteroOperationJWT({
      capabilities: ['model:invoke'],
      operationId: 'op-1',
      userId: 'user-1',
    });

  it('verifies in the issuing tenant and not in another tenant', async () => {
    const token = await inTenant('tenant-a', sign);

    await expect(
      inTenant('tenant-a', () => validateHeteroOperationJWT(token)),
    ).resolves.toMatchObject({ operation_id: 'op-1', sub: 'user-1', tid: 'tenant-a' });
    await expect(inTenant('tenant-b', () => validateHeteroOperationJWT(token))).resolves.toBeNull();
  });

  it('is rejected by the OIDC verifier of another tenant', async () => {
    const token = await inTenant('tenant-a', sign);

    await expect(inTenant('tenant-a', () => validateOIDCJWT(token))).resolves.toMatchObject({
      userId: 'user-1',
    });
    await expect(inTenant('tenant-b', () => validateOIDCJWT(token))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects claims minted for another tenant', async () => {
    const token = await inTenant('tenant-a', sign);
    const claims = decodeJwt(token) as Record<string, unknown>;

    expect(await inTenant('tenant-a', async () => validateHeteroOperationClaims(claims))).toEqual(
      claims,
    );
    expect(
      await inTenant('tenant-b', async () => validateHeteroOperationClaims(claims)),
    ).toBeNull();
    expect(
      await inTenant('tenant-a', async () =>
        validateHeteroOperationClaims({ ...claims, tid: undefined }),
      ),
    ).toBeNull();
  });
});

describe('internal JWT tenant binding', () => {
  it('carries the caller in the signed token and verifies in the issuing tenant', async () => {
    const token = await inTenant('tenant-a', () => signInternalJWT('user-1'));

    await expect(inTenant('tenant-a', () => validateInternalJWT(token))).resolves.toEqual({
      userId: 'user-1',
    });
  });

  it('is rejected in another tenant', async () => {
    const token = await inTenant('tenant-a', () => signInternalJWT('user-1'));

    await expect(inTenant('tenant-b', () => validateInternalJWT(token))).resolves.toBeNull();
  });

  it('rejects a token without a tenant claim or a user', async () => {
    const sign = (claims: Record<string, unknown>, subject?: string) => {
      const jwt = new SignJWT({ purpose: 'lobe-internal-call', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuedAt()
        .setExpirationTime('1m');
      return (subject ? jwt.setSubject(subject) : jwt).sign(privateKey);
    };

    await expect(
      inTenant('tenant-a', async () => validateInternalJWT(await sign({}, 'user-1'))),
    ).resolves.toBeNull();
    await expect(
      inTenant('tenant-a', async () => validateInternalJWT(await sign({ tid: 'tenant-a' }))),
    ).resolves.toBeNull();
  });

  it('does not accept another purpose of the same tenant as an internal call', async () => {
    const token = await inTenant('tenant-a', () => signUserJWT('user-1'));

    await expect(inTenant('tenant-a', () => validateInternalJWT(token))).resolves.toBeNull();
  });
});

describe('token signing requires a tenant', () => {
  it.each([
    ['signInternalJWT', () => signInternalJWT('user-1')],
    ['signUserJWT', () => signUserJWT('user-1')],
    [
      'signHeteroOperationJWT',
      () => signHeteroOperationJWT({ capabilities: [], operationId: 'op', userId: 'user-1' }),
    ],
    ['signWorkspaceDeviceToken', () => signWorkspaceDeviceToken('ws-1')],
    ['signTunnelAccessToken', () => signTunnelAccessToken({ userId: 'user-1' })],
  ])('%s fails outside a tenant scope', async (_name, sign) => {
    await expect(sign()).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
  });
});

describe('tokens verified by external services carry the tenant', () => {
  it('stamps the signing tenant on tunnel tokens', async () => {
    const tunnel = await inTenant('tenant-b', () => signTunnelAccessToken({ userId: 'user-1' }));

    expect(decodeJwt(tunnel)).toMatchObject({ tid: 'tenant-b', sub: 'user-1' });
  });
});
