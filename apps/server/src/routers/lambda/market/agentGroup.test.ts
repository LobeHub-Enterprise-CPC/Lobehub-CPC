// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { MarketAPIError } from '@lobehub/market-sdk';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentGroupRouter } from './agentGroup';

const { mockMarketSDK } = vi.hoisted(() => ({
  mockMarketSDK: {
    agentGroups: {
      deprecate: vi.fn(),
      getAgentGroupDetail: vi.fn(),
    },
    headers: {} as Record<string, string>,
  },
}));

vi.mock('@/business/server/trpc-middlewares/rbacPermission', () => ({
  withScopedPermission: vi.fn(function () {
    return (opts: any) => opts.next({ ctx: opts.ctx });
  }),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: vi.fn(function () {
    return {
      getUserState: vi.fn(async () => ({ settings: {} })),
    };
  }),
}));

vi.mock('@/libs/trpc/lambda/middleware', () => ({
  marketSDK: vi.fn(function (opts: any) {
    return opts.next({
      ctx: {
        ...opts.ctx,
        marketSDK: mockMarketSDK,
      },
    });
  }),
  marketUserInfo: vi.fn(function (opts: any) {
    return opts.next({
      ctx: {
        ...opts.ctx,
        marketUserInfo: { email: 'actor@example.com', name: 'Actor', userId: 'user-1' },
      },
    });
  }),
  serverDatabase: vi.fn(function (opts: any) {
    return opts.next({ ctx: opts.ctx });
  }),
}));

vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: vi.fn(function () {
    return 'trust-token';
  }),
}));

describe('agentGroupRouter.forkAgentGroup', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMarketSDK.headers = {};
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          group: { identifier: 'forked-group' },
          groupVersion: { versionNumber: 1 },
          memberAgents: [],
        }),
        { status: 200 },
      ),
    );
  });

  it('attributes workspace forks to the acting organization account', async () => {
    const caller = agentGroupRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    await caller.forkAgentGroup({
      actAs: 321,
      identifier: 'forked-group',
      name: 'Forked Group',
      sourceIdentifier: 'source-group',
      status: 'published',
      visibility: 'public',
    } as unknown as Parameters<typeof caller.forkAgentGroup>[0]);

    const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>)['x-lobe-owner-account-id']).toBe('321');
  });
});

describe('agentGroupRouter.checkOwnership', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMarketSDK.agentGroups.getAgentGroupDetail.mockResolvedValue({
      group: {
        avatar: '👥',
        identifier: 'workspace-group',
        name: 'Workspace Group',
        ownerId: 321,
      },
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ accountId: 999, sub: 'user-1' }), {
        status: 200,
      }),
    );
  });

  it('uses the acting organization account when checking workspace-owned groups', async () => {
    const caller = agentGroupRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    const result = await caller.checkOwnership({
      actAs: 321,
      identifier: 'workspace-group',
    } as unknown as Parameters<typeof caller.checkOwnership>[0]);

    expect(result).toMatchObject({
      exists: true,
      isOwner: true,
      originalGroup: null,
    });
  });
});

describe('agentGroupRouter.checkOwnership in a tenant', () => {
  const check = () =>
    runWithTenantScope(
      { session: {}, slug: 'acme', tenantId: 'tenant-a' } as unknown as TenantScope,
      () =>
        agentGroupRouter
          .createCaller({ serverDB: {}, userId: 'user-1' } as any)
          .checkOwnership({ identifier: 'org-group' }),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(JSON.stringify({ accountId: 999 }), { status: 200 }),
    );
  });

  // The owner of a piece of content is not the whole answer to "may this
  // requester edit it": a tenant's administrator may edit what they did not
  // write. Only Market can say, so its `canEdit` is all that is read.
  it('follows Market canEdit, not an owner comparison', async () => {
    mockMarketSDK.agentGroups.getAgentGroupDetail.mockResolvedValue({
      group: { canEdit: false, identifier: 'org-group', ownerId: 999 },
    });
    await expect(check()).resolves.toMatchObject({ exists: true, isOwner: false });

    mockMarketSDK.agentGroups.getAgentGroupDetail.mockResolvedValue({
      group: { canEdit: true, identifier: 'org-group', ownerId: 'tenant-org-account' },
    });
    await expect(check()).resolves.toMatchObject({ exists: true, isOwner: true });
  });

  it('grants nothing when Market did not say', async () => {
    mockMarketSDK.agentGroups.getAgentGroupDetail.mockResolvedValue({
      group: { identifier: 'org-group', ownerId: 999 },
    });

    await expect(check()).resolves.toMatchObject({ exists: true, isOwner: false });
  });

  // Market puts the group's capabilities on the group object. A value beside it
  // is not part of that contract and must not grant anything.
  it('reads the capabilities from the group object only, ignoring the top level', async () => {
    mockMarketSDK.agentGroups.getAgentGroupDetail.mockResolvedValue({
      canEdit: true,
      canUnpublish: true,
      group: { canEdit: false, identifier: 'org-group', ownerId: 999 },
    });
    await expect(check()).resolves.toMatchObject({ exists: true, isOwner: false });

    mockMarketSDK.agentGroups.getAgentGroupDetail.mockResolvedValue({
      canEdit: true,
      group: { identifier: 'org-group', ownerId: 999 },
    });
    await expect(check()).resolves.toMatchObject({ exists: true, isOwner: false });
  });

  it('says the group does not exist only when Market says it is not there', async () => {
    mockMarketSDK.agentGroups.getAgentGroupDetail.mockRejectedValue(
      new MarketAPIError(404, 'Not Found'),
    );

    await expect(check()).resolves.toEqual({ exists: false, isOwner: false, originalGroup: null });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])('fails, rather than reporting a missing group, on a Market %s', async (status, code) => {
    mockMarketSDK.agentGroups.getAgentGroupDetail.mockRejectedValue(
      new MarketAPIError(status, 'no'),
    );

    await expect(check()).rejects.toMatchObject({ code });
  });
});

describe('agentGroupRouter.getAgentGroupList', () => {
  const listWith = async (items: Record<string, unknown>[]) => {
    vi.spyOn(globalThis, 'fetch' as never).mockResolvedValue(
      new Response(JSON.stringify({ currentPage: 1, items, totalCount: items.length }), {
        status: 200,
      }),
    );
    const caller = agentGroupRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);
    return (await caller.getAgentGroupList({})).items as Record<string, unknown>[];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('keeps what Market says the requester may do, and nothing it did not say', async () => {
    const [granted, silent, wrongType] = await listWith([
      { canEdit: true, canUnpublish: false, identifier: 'a', name: 'A' },
      { identifier: 'b', name: 'B' },
      { canEdit: 'yes', canUnpublish: 1, identifier: 'c', name: 'C' },
    ]);

    expect(granted).toMatchObject({ canEdit: true, canUnpublish: false });
    for (const item of [silent, wrongType]) {
      expect(item).not.toHaveProperty('canEdit');
      expect(item).not.toHaveProperty('canUnpublish');
    }
  });

  it.each([
    ['no binding', null],
    ['still synced', { detached: false }],
    ['detached', { detached: true }],
  ])('keeps contentSync for %s', async (_name, contentSync) => {
    const [item] = await listWith([{ contentSync, identifier: 'a', name: 'A' }]);

    expect(item.contentSync).toEqual(contentSync);
  });

  it('forwards only {detached}, and nothing when the value is not a sync state', async () => {
    const [withExtras, notReported, invalid] = await listWith([
      { contentSync: { detached: true, hash: 'h', sourceId: 7 }, identifier: 'a', name: 'A' },
      { identifier: 'b', name: 'B' },
      { contentSync: 'detached', identifier: 'c', name: 'C' },
    ]);

    expect(withExtras.contentSync).toEqual({ detached: true });
    expect(notReported).not.toHaveProperty('contentSync');
    expect(invalid).not.toHaveProperty('contentSync');
  });
});

describe('agentGroupRouter.deprecateAgentGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarketSDK.agentGroups.deprecate.mockResolvedValue({ success: true });
  });

  it('deprecates the requested group and returns the Market result', async () => {
    const caller = agentGroupRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    const result = await caller.deprecateAgentGroup({ identifier: 'group-1' });

    expect(mockMarketSDK.agentGroups.deprecate).toHaveBeenCalledWith('group-1');
    expect(result).toEqual({ success: true });
  });

  it('maps a Market 404 to NOT_FOUND', async () => {
    mockMarketSDK.agentGroups.deprecate.mockRejectedValue(new MarketAPIError(404, 'Not Found'));
    const caller = agentGroupRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    const error = await caller.deprecateAgentGroup({ identifier: 'missing' }).catch((e) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe('NOT_FOUND');
  });
});
