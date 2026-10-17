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
const validateInternalJWT = vi.hoisted(() => vi.fn());
vi.mock('@/libs/trpc/utils/internalJwt', () => ({ validateInternalJWT }));

it.each([403, 503])(
  'internal JWT does not bypass platform %s and never runs the resolver',
  async (status) => {
    validateInternalJWT.mockResolvedValueOnce({ userId: 'alice' });
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
        serverDB: {} as never,
      });
    await expect(caller.work()).rejects.toMatchObject({
      code: status === 503 ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN',
    });
    expect(run).not.toHaveBeenCalled();
  },
);

it('runs as the user signed into the token', async () => {
  validateInternalJWT.mockResolvedValueOnce({ userId: 'alice' });
  const caller = asyncTrpc
    .router({ work: asyncTrpc.procedure.use(asyncAuth).query(({ ctx }) => ctx.userId) })
    .createCaller({
      authorizationToken: 'valid-internal-jwt',
      serverDB: {} as never,
    });

  await expect(caller.work()).resolves.toBe('alice');
});

it('rejects a token that is not valid for the current tenant before touching the database', async () => {
  validateInternalJWT.mockResolvedValueOnce(null);
  const run = vi.fn();
  const caller = asyncTrpc
    .router({ work: asyncTrpc.procedure.use(asyncAuth).query(run) })
    .createCaller({ authorizationToken: 'other-tenant-jwt', serverDB: {} as never });

  await expect(caller.work()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(run).not.toHaveBeenCalled();
});
