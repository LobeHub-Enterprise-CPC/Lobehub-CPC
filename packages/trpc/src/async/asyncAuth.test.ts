import { expect, it, vi } from 'vitest';

import { asyncAuth } from './asyncAuth';
import { asyncTrpc } from './init';

const access = vi.hoisted(() => vi.fn());
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: access,
  isBusinessAuthorizationError: (error: any) =>
    ['PLATFORM_ACCESS_DENIED', 'AUTHORIZATION_UNAVAILABLE'].includes(error?.code),
}));
vi.mock('@/database/models/user', () => ({
  UserModel: { findById: async () => ({ id: 'alice' }) },
}));
vi.mock('@/libs/trpc/utils/internalJwt', () => ({ validateInternalJWT: async () => true }));

it.each([403, 503])(
  'internal JWT does not bypass platform %s and never runs the resolver',
  async (status) => {
    access.mockRejectedValueOnce(
      Object.assign(new Error('platform'), {
        status,
        code: status === 503 ? 'AUTHORIZATION_UNAVAILABLE' : 'PLATFORM_ACCESS_DENIED',
      }),
    );
    const run = vi.fn(() => 'private-result');
    const caller = asyncTrpc
      .router({ work: asyncTrpc.procedure.use(asyncAuth).query(run) })
      .createCaller({
        authorizationToken: 'valid-internal-jwt',
        userId: 'alice',
        serverDB: {} as never,
      });
    await expect(caller.work()).rejects.toMatchObject({
      code: status === 503 ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN',
    });
    expect(run).not.toHaveBeenCalled();
  },
);
