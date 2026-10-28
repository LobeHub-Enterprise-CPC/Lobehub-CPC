import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { buildTrustedClientPayload, createTrustedClientToken } from '@lobehub/market-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generateTrustedClientToken as signToken,
  isSyntheticTrustedClientUserId,
  TrustedClientIdentityError,
  type TrustedClientUserInfo,
} from './index';

// Market takes a UUID as the tenant; the other one exists to tell two tenants apart.
const TENANT_A = '0f8b1c52-6a3e-4c7d-9a41-2d5e7b9c3a10';
const TENANT_B = '3b9f2a64-1c7e-4d58-8e0a-6f4d2c1b7a95';

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

// Every real token is signed for a tenant; the cases below that are not about
// the tenant run inside one.
const generateTrustedClientToken = (userInfo: TrustedClientUserInfo) =>
  inTenant(TENANT_A, () => signToken(userInfo));

const { appEnv } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id' as string | undefined,
    MARKET_TRUSTED_CLIENT_SECRET: 'client-secret' as string | undefined,
  },
}));

vi.mock('@/envs/app', () => ({ appEnv }));

vi.mock('@lobehub/market-sdk', () => ({
  buildTrustedClientPayload: vi.fn((params) => ({ ...params, nonce: 'n', timestamp: 0 })),
  createTrustedClientToken: vi.fn(() => 'signed-token'),
}));

beforeEach(() => {
  vi.clearAllMocks();
  appEnv.MARKET_TRUSTED_CLIENT_ID = 'client-id';
  appEnv.MARKET_TRUSTED_CLIENT_SECRET = 'client-secret';
});

describe('isSyntheticTrustedClientUserId', () => {
  it('flags eval_ and qstash_smoke_ prefixed ids', () => {
    expect(isSyntheticTrustedClientUserId('eval_123')).toBe(true);
    expect(isSyntheticTrustedClientUserId('qstash_smoke_abc')).toBe(true);
  });

  it('does not flag real user ids or near-misses', () => {
    expect(isSyntheticTrustedClientUserId('user_2abc')).toBe(false);
    // "evaluator_" starts with "eval" but not the "eval_" prefix
    expect(isSyntheticTrustedClientUserId('evaluator_1')).toBe(false);
    // prefix must be at the start
    expect(isSyntheticTrustedClientUserId('abc-eval_1')).toBe(false);
  });
});

describe('generateTrustedClientToken', () => {
  it('returns undefined for synthetic eval/smoke userIds without signing', () => {
    expect(generateTrustedClientToken({ userId: 'eval_xyz' })).toBeUndefined();
    expect(generateTrustedClientToken({ userId: 'qstash_smoke_1' })).toBeUndefined();
    expect(buildTrustedClientPayload).not.toHaveBeenCalled();
    expect(createTrustedClientToken).not.toHaveBeenCalled();
  });

  it('signs a token for a real userId', () => {
    const token = generateTrustedClientToken({ email: 'a@b.com', userId: 'user_real' });

    expect(token).toBe('client-id.signed-token');
    expect(buildTrustedClientPayload).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-id', userId: 'user_real' }),
    );
    expect(createTrustedClientToken).toHaveBeenCalledWith(expect.anything(), 'client-secret');
  });

  // R13: acting as an organization is closed inside a tenant. Every token this
  // module signs carries a tenantId, so none of them may carry a workspaceId:
  // Market refuses a tenant token that has one.
  it('never signs a workspaceId into a tenant token', () => {
    const token = generateTrustedClientToken({
      email: 'a@b.com',
      userId: 'user_real',
      workspaceId: 'wsp_1',
    });

    expect(token).toBe('client-id.signed-token');
    expect(buildTrustedClientPayload).toHaveBeenCalledWith(
      expect.not.objectContaining({ workspaceId: expect.anything() }),
    );
    const [payload] = vi.mocked(createTrustedClientToken).mock.calls[0];
    expect(payload).not.toHaveProperty('workspaceId');
    expect(payload).toMatchObject({ tenantId: TENANT_A, userId: 'user_real' });
  });

  // The claim is what the execution plane routes a persistent sandbox on, so it
  // has to be covered by the signature — a caller must not be able to supply it
  // alongside the token.
  it('signs the sandbox workspace claim into the payload', () => {
    generateTrustedClientToken({
      email: 'a@b.com',
      sandboxStorage: { key: 'ws-user_real', quotaBytes: 2048 },
      userId: 'user_real',
    });

    expect(createTrustedClientToken).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxStorage: { key: 'ws-user_real', quotaBytes: 2048 } }),
      'client-secret',
    );
  });

  // The published SDK builder has no parameter for it, so the field is attached
  // afterwards; passing it in would be silently dropped.
  it('does not route the claim through the SDK payload builder', () => {
    generateTrustedClientToken({
      sandboxStorage: { key: 'ws-user_real', quotaBytes: 2048 },
      userId: 'user_real',
    });

    expect(buildTrustedClientPayload).toHaveBeenCalledWith(
      expect.not.objectContaining({ sandboxStorage: expect.anything() }),
    );
  });

  // Free tier is the overwhelming majority of tokens; leaving the key out keeps
  // them exactly as they are today rather than carrying an explicit null.
  it('omits the claim entirely when there is no entitlement', () => {
    generateTrustedClientToken({ sandboxStorage: null, userId: 'user_real' });

    const [payload] = vi.mocked(createTrustedClientToken).mock.calls[0];
    expect(payload).not.toHaveProperty('sandboxStorage');
  });
});

describe('generateTrustedClientToken tenant claim', () => {
  const signedPayload = () => vi.mocked(createTrustedClientToken).mock.calls[0][0] as any;

  it('signs the tenant of the current scope into the token', () => {
    inTenant(TENANT_A, () => signToken({ email: 'a@b.com', userId: 'user_real' }));

    expect(signedPayload()).toMatchObject({ tenantId: TENANT_A, userId: 'user_real' });
  });

  // Operator reconciliation replays a receipt's identity outside any request.
  it('signs the tenant an identity carries when there is no scope', () => {
    signToken({ email: 'a@b.com', tenantId: TENANT_A, userId: 'user_real' });

    expect(signedPayload()).toMatchObject({ tenantId: TENANT_A });
  });

  it('refuses to sign without a tenant, and says so instead of returning no token', () => {
    expect(() => signToken({ email: 'a@b.com', userId: 'user_real' })).toThrowError(
      expect.objectContaining({ code: 'TENANT_REQUIRED' }),
    );
    expect(createTrustedClientToken).not.toHaveBeenCalled();
  });

  it('refuses an identity assembled under another tenant', () => {
    expect(() =>
      inTenant(TENANT_B, () =>
        signToken({ email: 'a@b.com', tenantId: TENANT_A, userId: 'user_real' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'TENANT_MISMATCH' }));
    expect(createTrustedClientToken).not.toHaveBeenCalled();
  });

  // Market takes the tenant as a UUID (the shared fixture lists what it accepts and rejects); any
  // other id would be a guaranteed 401 from Market, so fail here with a name for it.
  it.each(['tenant:a', 'tenant a', 'x'.repeat(65), 'té', 'tenant-a', TENANT_A.toUpperCase()])(
    'refuses a tenant id Market cannot take: %s',
    (tenantId) => {
      expect(() => inTenant(tenantId, () => signToken({ userId: 'user_real' }))).toThrowError(
        expect.objectContaining({ code: 'TENANT_ID_UNSUPPORTED' }),
      );
    },
  );

  it('reports the failure as a TrustedClientIdentityError', () => {
    expect(() => signToken({ userId: 'user_real' })).toThrowError(TrustedClientIdentityError);
  });

  // "Trusted client is off" is a configuration the caller falls back from; it is
  // not an identity failure, so it needs no tenant and raises nothing.
  it('returns undefined, without needing a tenant, when trusted client is not configured', () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;

    expect(signToken({ userId: 'user_real' })).toBeUndefined();
    expect(createTrustedClientToken).not.toHaveBeenCalled();
  });

  it('still returns undefined, without needing a tenant, for a synthetic user', () => {
    expect(signToken({ userId: 'eval_xyz' })).toBeUndefined();
  });
});

// Tenant mode is "a tenant scope is running, or trusted client is configured".
// In it a Market request must carry a trust token or not leave at all: an
// unsigned request lands in the default instance (public reads) or is refused
// (a legacy Bearer), neither of which is the tenant the user asked for.
describe('generateTrustedClientToken fails closed in tenant mode', () => {
  const secretLike = 'x'.repeat(83);

  it.each([
    ['secret', () => (appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined)],
    ['id', () => (appEnv.MARKET_TRUSTED_CLIENT_ID = undefined)],
  ])(
    'refuses to continue unsigned when the trusted client %s is missing in a tenant',
    (_, unset) => {
      unset();

      expect(() =>
        generateTrustedClientToken({ email: 'a@b.com', userId: 'user_real' }),
      ).toThrowError(expect.objectContaining({ code: 'TRUST_NOT_CONFIGURED' }));
      expect(createTrustedClientToken).not.toHaveBeenCalled();
    },
  );

  it('refuses unsigned for an identity that carries its tenant, even outside a scope', () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;

    expect(() =>
      signToken({ email: 'a@b.com', tenantId: TENANT_A, userId: 'user_real' }),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_NOT_CONFIGURED' }));
  });

  it('surfaces a signing failure as TRUST_SIGNING_FAILED instead of "no token"', () => {
    vi.mocked(createTrustedClientToken).mockImplementationOnce(() => {
      throw new Error(`bad secret ${secretLike}`);
    });

    const attempt = () => generateTrustedClientToken({ email: 'a@b.com', userId: 'user_real' });

    expect(attempt).toThrowError(TrustedClientIdentityError);
    vi.mocked(createTrustedClientToken).mockImplementationOnce(() => {
      throw new Error(`bad secret ${secretLike}`);
    });
    expect(attempt).toThrowError(expect.objectContaining({ code: 'TRUST_SIGNING_FAILED' }));
  });

  it('logs the failure without the secret, a token, the payload or the SDK message', () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = secretLike;
    vi.mocked(createTrustedClientToken).mockImplementationOnce(() => {
      throw new Error(`bad secret ${secretLike}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let thrown: unknown;
    try {
      generateTrustedClientToken({ email: 'private@b.com', userId: 'user_real' });
    } catch (error) {
      thrown = error;
    }

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(errorSpy).toHaveBeenCalled();
    expect(logged).not.toContain(secretLike);
    expect(logged).not.toContain('private@b.com');
    expect(logged).toContain('TRUST_SIGNING_FAILED');
    expect(String((thrown as Error).message)).not.toContain(secretLike);
    expect((thrown as Error).cause).toBeUndefined();
    errorSpy.mockRestore();
  });

  it('keeps the community behaviour: no scope and nothing configured is just "no token"', () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;

    expect(signToken({ userId: 'user_real' })).toBeUndefined();
  });
});

// Market finds the signing secret from the plaintext kid in front of the ciphertext instead of
// trying every tenant's secrets (cost grows with the tenant count otherwise). The kid is only a
// lookup key: the signed payload has to carry the same `clientId` and decrypt under that
// client's secret. SDK 0.42 cannot add a request header, so the kid rides inside the token.
describe('trust token kid', () => {
  it('puts the client id in plaintext in front of the SDK ciphertext', () => {
    const token = generateTrustedClientToken({ email: 'a@b.com', userId: 'user_real' });

    expect(token).toBe('client-id.signed-token');
  });

  it('signs the same client id into the payload, so Market can bind kid and payload', () => {
    generateTrustedClientToken({ email: 'a@b.com', userId: 'user_real' });

    expect(vi.mocked(createTrustedClientToken).mock.calls[0][0]).toMatchObject({
      clientId: 'client-id',
    });
  });

  it('fails closed with TRUST_SIGNING_FAILED when the client id cannot be a kid', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const unusable of ['has space', 'ünïcode', 'x'.repeat(101)]) {
      appEnv.MARKET_TRUSTED_CLIENT_ID = unusable;
      expect(() => generateTrustedClientToken({ userId: 'user_real' })).toThrowError(
        expect.objectContaining({ code: 'TRUST_SIGNING_FAILED' }),
      );
    }
    expect(createTrustedClientToken).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('still returns undefined where no token is produced (synthetic user, trust off)', () => {
    expect(signToken({ userId: 'eval_xyz' })).toBeUndefined();

    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
    expect(signToken({ userId: 'user_real' })).toBeUndefined();
  });
});
