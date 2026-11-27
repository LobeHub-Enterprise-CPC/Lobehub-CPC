import { deriveSandboxStorageKey } from '@lobechat/builtin-tool-cloud-sandbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDriveAccess } from '../driveAccess';
import { readDriveUsage } from '../driveUsage';

const memberGetStorage = vi.fn();
const marketEmail = 'owner@example.test';

vi.mock('@/libs/trusted-client/resolveIdentity', () => ({
  resolveMarketServiceIdentity: async ({
    sandboxStorage,
    userId,
  }: {
    sandboxStorage: { key: string };
    userId: string;
  }) => ({ email: userId === 'owner' ? marketEmail : undefined, sandboxStorage, userId }),
}));

vi.mock('@/server/services/market', () => ({
  // `function`, not an arrow: the service is constructed with `new`.
  MarketService: vi.fn().mockImplementation(function (options: {
    userInfo?: { email?: string; sandboxStorage?: { key: string } };
  }) {
    return {
      getSandboxStorageClient: () => ({
        getStorage: async () => {
          if (options.userInfo?.email !== marketEmail) throw new Error('Market rejected identity');
          return memberGetStorage(options.userInfo.sandboxStorage?.key);
        },
      }),
    };
  }),
}));

const WORKSPACE = 'ws1';
const members = [
  { avatar: null, fullName: 'Owner', userId: 'owner', username: null },
  { avatar: null, fullName: 'Ada', userId: 'ada', username: null },
  { avatar: null, fullName: 'Bo', userId: 'bo', username: null },
];

const serverDB = {
  select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => members }) }) }),
} as any;

const accessWith = (publicInfo: Record<string, unknown>) => {
  const getStorage = vi.fn(async (params?: { withDrives?: boolean }) =>
    params?.withDrives ? publicInfo : { ...publicInfo, workspaceDrives: undefined },
  );
  const personal = vi.fn(async () => ({ usageBytes: 5 }));
  return {
    access: {
      available: ['public', 'personal'],
      client: async (drive: string) => ({
        client: { getStorage: drive === 'public' ? getStorage : personal },
      }),
    } as any,
    getStorage,
  };
};

const read = (access: any, role = 'owner') =>
  readDriveUsage({
    claim: { key: 'ws-org-ws1', quotaBytes: 1000 },
    drives: access,
    role,
    serverDB,
    userId: 'owner',
    workspaceId: WORKSPACE,
  });

describe('readDriveUsage', () => {
  beforeEach(() => {
    memberGetStorage.mockReset().mockResolvedValue({ usageBytes: 1 });
  });

  it('should read the personal drive usage with the caller’s Market identity', async () => {
    const claim = { key: 'ws-owner', quotaBytes: 1000 };
    const drives = createDriveAccess({
      resolveClaim: async () => claim,
      serverDB,
      userId: 'owner',
    });

    await expect(
      readDriveUsage({ claim, drives, serverDB, userId: 'owner' }),
    ).resolves.toMatchObject({
      drives: [{ drive: 'personal', usageBytes: 1 }],
      quotaBytes: 1000,
      totalUsageBytes: 1,
    });
    expect(memberGetStorage).toHaveBeenCalledWith('ws-owner');
  });

  it("should take members' figures from the pool listing, without a read per member", async () => {
    const adaKey = deriveSandboxStorageKey({
      drive: 'personal',
      userId: 'ada',
      workspaceId: WORKSPACE,
    });
    const { access, getStorage } = accessWith({
      usageBytes: 100,
      workspaceDrives: [
        { storageKey: 'ws-org-ws1', usageBytes: 100 },
        { storageKey: adaKey, usageBytes: 40 },
      ],
      workspaceUsageBytes: 145,
    });

    const usage = await read(access);

    expect(getStorage).toHaveBeenCalledWith({ withDrives: true });
    expect(memberGetStorage).not.toHaveBeenCalled();
    expect(usage.members).toEqual([
      expect.objectContaining({ usageBytes: 40, userId: 'ada' }),
      // No row in the pool: never had a session, so nothing measured.
      expect.objectContaining({ usageBytes: null, userId: 'bo' }),
    ]);
  });

  it('should fall back to a read per member when the pool cannot be listed', async () => {
    const { access } = accessWith({ usageBytes: 100, workspaceUsageBytes: 145 });

    const usage = await read(access);

    expect(memberGetStorage.mock.calls.flat().sort()).toEqual(['ws-mem-ws1-ada', 'ws-mem-ws1-bo']);
    expect(usage.members?.map((member) => member.usageBytes)).toEqual([1, 1]);
  });

  it('should not ask for the pool, or list members, for a plain member', async () => {
    const { access, getStorage } = accessWith({ usageBytes: 100 });

    const usage = await read(access, 'member');

    expect(getStorage).toHaveBeenCalledWith({ withDrives: false });
    expect(usage.members).toBeNull();
  });
});
