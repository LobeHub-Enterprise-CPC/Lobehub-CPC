/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  capturedLogs,
  expectNoSecretsLogged,
  SENTINELS,
  startLogCapture,
  stopLogCapture,
} from './__tests__/logCapture';
import { DrizzleAdapter } from './adapter';
import { validateOIDCJWT } from './jwt';

const mocks = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  tenantBound: vi.fn(() => true),
}));

vi.mock('debug', async () => (await import('./__tests__/logCapture')).debugMock);

vi.mock('@lobechat/utils/server', () => ({
  getUserAuth: vi.fn(async () => ({ userId: 'user-1' })),
}));

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    initWithEnvKey: async () => ({
      decrypt: async (value: string) => ({ plaintext: value, wasAuthentic: true }),
      encrypt: async (value: string) => value,
    }),
  },
}));

vi.mock('@/envs/auth', () => ({
  authEnv: {
    JWKS_KEY: JSON.stringify({
      keys: [{ alg: 'RS256', e: 'AQAB', kid: 'k', kty: 'RSA', n: 'modulus', use: 'sig' }],
    }),
  },
}));
vi.mock('@/libs/trpc/utils/tenantBinding', () => ({ isBoundToCurrentTenant: mocks.tenantBound }));
vi.mock('jose', () => ({
  createLocalJWKSet: () => 'public-key-set',
  decodeProtectedHeader: () => ({ kid: 'k' }),
  importJWK: async () => 'public-key',
  jwtVerify: mocks.jwtVerify,
}));

/** Every builder call returns the same chain; awaiting it settles with `run()`. */
const fakeDb = (run: () => Promise<unknown>) => {
  const chain: any = new Proxy(() => {}, {
    apply: () => chain,
    get: (_target, property) =>
      property === 'then'
        ? (resolve: any, reject: any) => run().then(resolve, reject)
        : () => chain,
  });
  return {
    delete: () => chain,
    insert: () => chain,
    select: () => chain,
    transaction: async (callback: (tx: unknown) => Promise<void>) =>
      callback({ delete: () => chain }),
    update: () => chain,
  } as any;
};

const sensitiveData = {
  accountId: 'user-1',
  clientId: 'lobehub-desktop',
  codeChallenge: SENTINELS.challenge,
  grantId: SENTINELS.grant,
  jti: SENTINELS.token,
  params: { code_challenge: SENTINELS.challenge, state: SENTINELS.state },
  uid: SENTINELS.uid,
  userCode: SENTINELS.code,
};

const row = (extra: Record<string, unknown> = {}) => ({
  data: sensitiveData,
  grantId: SENTINELS.grant,
  id: SENTINELS.code,
  userCode: SENTINELS.code,
  userId: 'user-1',
  ...extra,
});

describe('OIDC library logs never carry credentials', () => {
  beforeEach(() => {
    mocks.tenantBound.mockReturnValue(true);
    startLogCapture();
  });

  afterEach(() => {
    stopLogCapture();
  });

  describe('DrizzleAdapter', () => {
    const models = ['AuthorizationCode', 'AccessToken', 'RefreshToken', 'DeviceCode', 'Session'];

    it.each(models)(
      '%s: upsert, find, consume and destroy log no ids or payloads',
      async (model) => {
        const adapter = new DrizzleAdapter(
          model,
          fakeDb(async () => [row()]),
        );

        await adapter.upsert(SENTINELS.code, { ...sensitiveData }, 600);
        await adapter.find(SENTINELS.code);
        await adapter.consume(SENTINELS.code);
        await adapter.destroy(SENTINELS.code);
        await adapter.revokeByGrantId(SENTINELS.grant);

        expect(capturedLogs()).not.toBe('');
        expectNoSecretsLogged();
      },
    );

    it('does not log expired or consumed records', async () => {
      const past = new Date(Date.now() - 60_000);
      for (const name of ['AuthorizationCode', 'RefreshToken']) {
        for (const extra of [{ expiresAt: past }, { consumedAt: past }]) {
          await new DrizzleAdapter(
            name,
            fakeDb(async () => [row(extra)]),
          ).find(SENTINELS.code);
        }
      }
      expectNoSecretsLogged();
    });

    it('does not log session or device code lookups', async () => {
      const adapter = new DrizzleAdapter(
        'Session',
        fakeDb(async () => [row()]),
      );
      await adapter.findByUid(SENTINELS.uid);
      await adapter.findSessionByUserId('user-1');
      await new DrizzleAdapter(
        'DeviceCode',
        fakeDb(async () => [row()]),
      ).findByUserCode(SENTINELS.code);
      await new DrizzleAdapter(
        'Session',
        fakeDb(async () => []),
      ).findByUid(SENTINELS.uid);
      await new DrizzleAdapter(
        'DeviceCode',
        fakeDb(async () => []),
      ).findByUserCode(SENTINELS.code);

      expectNoSecretsLogged();
    });

    it('does not log database failures, whose text embeds the query parameters', async () => {
      const failure = () =>
        Promise.reject(
          new Error(
            `Failed query: insert into oidc ... params: ${SENTINELS.code},${SENTINELS.state},${SENTINELS.challenge}`,
          ),
        );
      const adapter = new DrizzleAdapter('AuthorizationCode', fakeDb(failure));

      await expect(adapter.upsert(SENTINELS.code, { ...sensitiveData }, 600)).rejects.toThrow();
      await adapter.find(SENTINELS.code);
      await expect(adapter.consume(SENTINELS.code)).rejects.toThrow();
      await expect(adapter.destroy(SENTINELS.code)).rejects.toThrow();
      await expect(adapter.revokeByGrantId(SENTINELS.grant)).rejects.toThrow();
      await new DrizzleAdapter('Session', fakeDb(failure)).findByUid(SENTINELS.uid);
      await new DrizzleAdapter('Session', fakeDb(failure)).findSessionByUserId('user-1');
      await new DrizzleAdapter('DeviceCode', fakeDb(failure)).findByUserCode(SENTINELS.code);

      expect(console.error).toHaveBeenCalled();
      expectNoSecretsLogged();
    });
  });

  describe('validateOIDCJWT', () => {
    it('does not log the claims of a verified token', async () => {
      mocks.jwtVerify.mockResolvedValue({
        payload: { client_id: 'c', email: SENTINELS.cookie, jti: SENTINELS.token, sub: 'user-1' },
      });

      await validateOIDCJWT('header.payload.signature');

      expectNoSecretsLogged();
    });

    it('does not log the claims attached to a verification failure', async () => {
      mocks.jwtVerify.mockRejectedValue(
        Object.assign(new Error(`"exp" claim failed ${SENTINELS.token}`), {
          code: 'ERR_JWT_EXPIRED',
          payload: { jti: SENTINELS.token },
        }),
      );

      await expect(validateOIDCJWT('header.payload.signature')).rejects.toThrow();

      expectNoSecretsLogged();
    });
  });
});
