import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/envs/auth', () => ({
  authEnv: {
    ENABLE_OIDC: true,
    JWKS_KEY: JSON.stringify({
      keys: [
        {
          alg: 'RS256',
          e: 'AQAB',
          kid: 'test-key',
          kty: 'RSA',
          n: 'test-modulus',
          use: 'sig',
        },
      ],
    }),
  },
}));

// Tokens are bound to the tenant of the request by their signed `tid` claim.
const tenantBound = vi.hoisted(() => vi.fn());
vi.mock('@/libs/trpc/utils/tenantBinding', () => ({ isBoundToCurrentTenant: tenantBound }));

// The tenant's OIDC provider decides which clients still exist.
const findClient = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/oidc/oidcProvider', () => ({
  getOIDCProvider: async () => ({ Client: { find: findClient } }),
}));

const importJWKMock = vi.fn();
const createLocalJWKSetMock = vi.fn();
const decodeProtectedHeaderMock = vi.fn();
const jwtVerifyMock = vi.fn();

vi.mock('jose', () => ({
  createLocalJWKSet: (...args: unknown[]) => createLocalJWKSetMock(...args),
  decodeProtectedHeader: (...args: unknown[]) => decodeProtectedHeaderMock(...args),
  importJWK: (...args: unknown[]) => importJWKMock(...args),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

describe('validateOIDCJWT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createLocalJWKSetMock.mockReturnValue('public-key-set');
    decodeProtectedHeaderMock.mockReturnValue({ kid: 'test-key' });
    importJWKMock.mockResolvedValue('public-key');
    tenantBound.mockReturnValue(true);
    findClient.mockImplementation(async (clientId: string) => ({ clientId }));
  });

  it('accepts a token of a client the provider still serves', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { client_id: 'tituwork-desktop', sub: 'user-1' },
    });
    const { validateOIDCJWT } = await import('./jwt');
    await expect(validateOIDCJWT('t')).resolves.toMatchObject({
      clientId: 'tituwork-desktop',
      userId: 'user-1',
    });
  });

  it('refuses a token whose client was renamed, removed or disabled', async () => {
    findClient.mockResolvedValue(undefined);
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { client_id: 'lobehub-desktop', sub: 'user-1' },
    });
    const { validateOIDCJWT } = await import('./jwt');
    await expect(validateOIDCJWT('t')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'JWT token was issued to a retired client',
    });
    expect(findClient).toHaveBeenCalledWith('lobehub-desktop');
  });

  it('reports a provider that cannot answer as a server fault, not a rejected token', async () => {
    findClient.mockRejectedValueOnce(new Error('provider init failed'));
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { client_id: 'tituwork-desktop', sub: 'user-1' },
    });
    const { validateOIDCJWT } = await import('./jwt');
    const error = await validateOIDCJWT('t').catch((error_) => error_);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TRPCError);
  });

  it('does not ask the provider about server-minted tokens, which name no client', async () => {
    findClient.mockResolvedValue(undefined);
    jwtVerifyMock.mockResolvedValueOnce({ payload: { purpose: 'cli-sandbox', sub: 'user-1' } });
    const { validateOIDCJWT } = await import('./jwt');
    await expect(validateOIDCJWT('t')).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('should preserve the original jose error as TRPCError cause', async () => {
    const joseError = Object.assign(new Error('"exp" claim timestamp check failed'), {
      code: 'ERR_JWT_EXPIRED',
    });
    jwtVerifyMock.mockRejectedValueOnce(joseError);

    const { validateOIDCJWT } = await import('./jwt');

    await expect(validateOIDCJWT('header.payload.signature')).rejects.toMatchObject({
      cause: joseError,
      code: 'UNAUTHORIZED',
    });
  });

  it('should not wrap JWKS/public key retrieval failures as TRPCError', async () => {
    importJWKMock.mockRejectedValueOnce(new Error('invalid JWK'));

    const { validateOIDCJWT } = await import('./jwt');

    const error = await validateOIDCJWT('header.payload.signature').catch((error_) => error_);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TRPCError);
    expect((error as Error).message).toBe('JWKS_KEY public key retrieval failed: invalid JWK');
  });
});

describe('acceptance review tokens', () => {
  const REVIEW_AUD = 'urn:lobehub:acceptance:7f0c9a7e-0000-4000-8000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    createLocalJWKSetMock.mockReturnValue('public-key-set');
    decodeProtectedHeaderMock.mockReturnValue({ kid: 'test-key' });
    importJWKMock.mockResolvedValue('public-key');
    tenantBound.mockReturnValue(true);
    findClient.mockImplementation(async (clientId: string) => ({ clientId }));
  });

  it('are refused as an app session', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { aud: REVIEW_AUD, client_id: 'lobehub-review', sub: 'user-1' },
    });
    const { validateOIDCJWT } = await import('./jwt');
    await expect(validateOIDCJWT('t')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuse anything else the review client was issued, such as its ID token', async () => {
    const { validateOIDCJWT } = await import('./jwt');
    jwtVerifyMock.mockResolvedValueOnce({ payload: { aud: 'lobehub-review', sub: 'user-1' } });
    await expect(validateOIDCJWT('t')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { aud: ['urn:lobehub:chat'], client_id: 'lobehub-review', sub: 'user-1' },
    });
    await expect(validateOIDCJWT('t')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('do not affect tokens for the app API', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { aud: 'urn:lobehub:chat', client_id: 'tituwork-desktop', sub: 'user-1' },
    });
    const { validateOIDCJWT } = await import('./jwt');
    await expect(validateOIDCJWT('t')).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('are read back as the acceptance and user they were issued for', async () => {
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { aud: REVIEW_AUD, client_id: 'lobehub-review', exp: 1_800_000_000, sub: 'user-1' },
    });
    const { verifyAcceptanceReviewJWT } = await import('./jwt');
    await expect(verifyAcceptanceReviewJWT('t')).resolves.toEqual({
      acceptanceId: '7f0c9a7e-0000-4000-8000-000000000001',
      expiresAt: 1_800_000_000,
      userId: 'user-1',
    });
  });

  it('are refused when issued for another tenant', async () => {
    tenantBound.mockReturnValue(false);
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { aud: REVIEW_AUD, client_id: 'lobehub-review', exp: 1_800_000_000, sub: 'user-1' },
    });
    const { verifyAcceptanceReviewJWT } = await import('./jwt');
    await expect(verifyAcceptanceReviewJWT('t')).rejects.toThrow('not issued for this tenant');
  });

  it('reject any other token as a review token', async () => {
    const { verifyAcceptanceReviewJWT } = await import('./jwt');
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { aud: 'urn:lobehub:chat', client_id: 'tituwork-desktop', sub: 'user-1' },
    });
    await expect(verifyAcceptanceReviewJWT('t')).rejects.toThrow();
    jwtVerifyMock.mockResolvedValueOnce({
      payload: { aud: REVIEW_AUD, client_id: 'lobehub-cli', sub: 'user-1' },
    });
    await expect(verifyAcceptanceReviewJWT('t')).rejects.toThrow();
  });
});
