import type { TenantScope } from '@lobechat/database/tenant/requestScope';
import { runWithTenantScope } from '@lobechat/database/tenant/requestScope';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { UserService } from '../user.service';

const mocks = vi.hoisted(() => {
  class SeatLimitError extends Error {}
  return {
    SeatLimitError,
    withSeatLimit: vi.fn(),
  };
});

vi.mock('@lobechat/database/platform', () => ({
  SeatLimitError: mocks.SeatLimitError,
  withSeatLimit: mocks.withSeatLimit,
}));

const insert = vi.fn();
const db = {
  insert,
  query: { users: { findFirst: vi.fn().mockResolvedValue(undefined) } },
} as unknown as LobeChatDatabase;

const inTenant = <T>(operation: () => Promise<T>) =>
  runWithTenantScope({ tenantId: 'tenant-1' } as TenantScope, operation);

const makeService = () => {
  const service = new UserService(db, 'admin-1');
  Object.assign(service, {
    getUserWithRoles: vi.fn().mockResolvedValue({ id: 'new-user' }),
    resolveOperationPermission: vi.fn().mockResolvedValue({ isPermitted: true }),
  });
  return service;
};

describe('UserService.createUser seat limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the account through the tenant seat limit', async () => {
    mocks.withSeatLimit.mockImplementation(async (database, _tenantId, create) => create(database));
    insert.mockReturnValue({
      values: () => ({ returning: async () => [{ id: 'new-user' }] }),
    });

    await expect(
      inTenant(() => makeService().createUser({ email: 'a@acme.test' } as never)),
    ).resolves.toEqual({ id: 'new-user' });
    expect(mocks.withSeatLimit).toHaveBeenCalledWith(db, 'tenant-1', expect.any(Function));
  });

  it('refuses with the seat message and inserts nothing when the tenant is full', async () => {
    mocks.withSeatLimit.mockRejectedValue(new mocks.SeatLimitError());

    await expect(
      inTenant(() => makeService().createUser({ email: 'a@acme.test' } as never)),
    ).rejects.toMatchObject({ message: '组织席位已满，请联系管理员', name: 'BusinessError' });
    expect(insert).not.toHaveBeenCalled();
  });
});
