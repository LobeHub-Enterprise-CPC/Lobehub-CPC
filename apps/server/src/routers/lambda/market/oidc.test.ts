// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  capturedLogs,
  expectNoSecretsLogged,
  SENTINELS,
  startLogCapture,
  stopLogCapture,
} from '@/libs/oidc-provider/__tests__/logCapture';

const market = vi.hoisted(() => ({
  exchangeAuthorizationCode: vi.fn(),
  getOAuthHandoff: vi.fn(),
  getUserInfo: vi.fn(),
  refreshToken: vi.fn(),
}));

vi.mock('debug', async () => (await import('@/libs/oidc-provider/__tests__/logCapture')).debugMock);

vi.mock('@/libs/trpc/lambda/middleware', () => ({
  marketUserInfo: vi.fn((opts: any) =>
    opts.next({ ctx: { ...opts.ctx, marketUserInfo: undefined } }),
  ),
  serverDatabase: vi.fn((opts: any) => opts.next(opts)),
}));

vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn(function () {
    return market;
  }),
}));

const failure = () => new Error(`upstream failed: ${SENTINELS.code} ${SENTINELS.token}`);

describe('market OIDC router logs never carry credentials', () => {
  beforeEach(startLogCapture);
  afterEach(stopLogCapture);

  const caller = async () => {
    const { oidcRouter } = await import('./oidc');
    return oidcRouter.createCaller({} as never);
  };

  it('does not log the authorization code exchange', async () => {
    const trpc = await caller();
    const input = {
      clientId: 'lobehub-desktop',
      code: SENTINELS.code,
      codeVerifier: SENTINELS.challenge,
      redirectUri: `https://app.example.com/cb?state=${SENTINELS.state}`,
    };
    market.exchangeAuthorizationCode.mockResolvedValueOnce({ access_token: SENTINELS.token });
    await trpc.exchangeAuthorizationCode(input);

    market.exchangeAuthorizationCode.mockRejectedValueOnce(failure());
    await expect(trpc.exchangeAuthorizationCode(input)).rejects.toThrow();

    expect(capturedLogs()).not.toBe('');
    expectNoSecretsLogged();
  });

  it('does not log the handoff id', async () => {
    const trpc = await caller();
    market.getOAuthHandoff.mockResolvedValueOnce({ code: SENTINELS.code });
    await trpc.getOAuthHandoff({ id: SENTINELS.handoff });

    market.getOAuthHandoff.mockRejectedValueOnce(failure());
    await expect(trpc.getOAuthHandoff({ id: SENTINELS.handoff })).rejects.toThrow();

    expectNoSecretsLogged();
  });

  it('does not log the user info token', async () => {
    const trpc = await caller();
    market.getUserInfo.mockResolvedValueOnce({ sub: 'user-1' });
    await trpc.getUserInfo({ token: SENTINELS.token });

    market.getUserInfo.mockRejectedValueOnce(failure());
    await expect(trpc.getUserInfo({ token: SENTINELS.token })).rejects.toThrow();

    expectNoSecretsLogged();
  });

  it('does not log the refresh', async () => {
    const trpc = await caller();
    market.refreshToken.mockResolvedValueOnce({ access_token: SENTINELS.token });
    await trpc.refreshToken({ clientId: 'lobehub-desktop', refreshToken: SENTINELS.token });

    market.refreshToken.mockRejectedValueOnce(failure());
    await expect(
      trpc.refreshToken({ clientId: 'lobehub-desktop', refreshToken: SENTINELS.token }),
    ).rejects.toThrow();

    expectNoSecretsLogged();
  });
});
