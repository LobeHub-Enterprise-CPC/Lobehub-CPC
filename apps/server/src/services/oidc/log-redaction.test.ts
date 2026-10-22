import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  expectNoSecretsLogged,
  SENTINELS,
  startLogCapture,
  stopLogCapture,
} from '@/libs/oidc-provider/__tests__/logCapture';

import { OIDCService } from '.';

vi.mock('debug', async () => (await import('@/libs/oidc-provider/__tests__/logCapture')).debugMock);
vi.mock('@lobechat/database', () => ({ getServerDB: vi.fn() }));
vi.mock('@lobechat/database/schemas', () => ({ oidcClients: {}, users: {} }));
vi.mock('@/libs/oidc-provider/config', () => ({ defaultClients: [] }));
vi.mock('@/libs/oidc-provider/http-adapter', () => ({
  createContextForInteractionDetails: vi.fn(),
}));
vi.mock('./oidcProvider', () => ({ getOIDCProvider: vi.fn() }));

const providerWith = (grant: unknown) => ({
  Grant: Object.assign(
    vi.fn().mockImplementation(function (payload) {
      return { ...payload, destroy: vi.fn() };
    }),
    { find: vi.fn().mockResolvedValue(grant) },
  ),
});

describe('OIDCService logs never carry grant ids or failure text', () => {
  beforeEach(startLogCapture);
  afterEach(stopLogCapture);

  it.each([
    ['reused', { accountId: 'account-1', clientId: 'client-1', destroy: vi.fn() }],
    [
      'discarded after a failed cleanup',
      {
        accountId: 'other',
        clientId: 'client-1',
        destroy: vi.fn().mockRejectedValue(new Error(`destroy failed ${SENTINELS.grant}`)),
      },
    ],
    ['missing from storage', undefined],
  ])('a grant that is %s', async (_name, grant) => {
    const service = new OIDCService(providerWith(grant) as never);

    await service.findOrCreateGrants('account-1', 'client-1', SENTINELS.grant);

    expectNoSecretsLogged();
  });
});
