// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { MarketAPIError } from '@lobehub/market-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentRouter } from './agent';

const { mockMarketSDK, mockCreateAgentVersionHeader } = vi.hoisted(() => {
  const mockCreateAgentVersionHeader = vi.fn();
  const mockMarketSDK = {
    agents: {
      createAgent: vi.fn(),
      createAgentVersion: vi.fn(async () => {
        mockCreateAgentVersionHeader(mockMarketSDK.headers['x-lobe-owner-account-id']);
        return { success: true };
      }),
      getAgentDetail: vi.fn(),
    },
    headers: {} as Record<string, string>,
  };

  return { mockCreateAgentVersionHeader, mockMarketSDK };
});

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

describe('agentRouter.publishOrCreate', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMarketSDK.headers = {};
    mockMarketSDK.agents.getAgentDetail.mockResolvedValue({
      identifier: 'existing-agent',
      name: 'Existing Agent',
      ownerId: 123,
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ accountId: 999, sub: 'user-1' }), {
        status: 200,
      }),
    );
  });

  it('uses the acting organization account for ownership checks and version uploads', async () => {
    const caller = agentRouter.createCaller({ serverDB: {}, userId: 'user-1' } as any);

    const result = await caller.publishOrCreate({
      actAs: 123,
      identifier: 'existing-agent',
      name: 'Existing Agent',
    });

    expect(result).toEqual({
      identifier: 'existing-agent',
      isNewAgent: false,
      success: true,
    });
    expect(mockMarketSDK.agents.createAgent).not.toHaveBeenCalled();
    expect(mockMarketSDK.agents.createAgentVersion).toHaveBeenCalledWith({
      identifier: 'existing-agent',
      name: 'Existing Agent',
    });
    expect(mockCreateAgentVersionHeader).toHaveBeenCalledWith('123');
    expect(mockMarketSDK.headers['x-lobe-owner-account-id']).toBeUndefined();
  });
});

describe('agentRouter in a tenant', () => {
  const inTenant = <T>(fn: () => T) =>
    runWithTenantScope(
      { session: {}, slug: 'acme', tenantId: 'tenant-a' } as unknown as TenantScope,
      fn,
    );
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMarketSDK.headers = {};
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ accountId: 999 }), { status: 200 }));
  });

  // The owner of a piece of content is not the whole answer to "may this
  // requester edit it": a tenant's administrator may edit what they did not
  // write. Only Market can say, so its `canEdit` is all that is read.
  describe('checkOwnership', () => {
    const check = () =>
      inTenant(() =>
        agentRouter
          .createCaller({ serverDB: {}, userId: 'user-1' } as any)
          .checkOwnership({ identifier: 'org-agent' }),
      );

    it('follows Market canEdit, not an owner comparison', async () => {
      // ownerId equals the requester's own account id: legacy logic would say yes.
      mockMarketSDK.agents.getAgentDetail.mockResolvedValue({
        canEdit: false,
        ownerId: 999,
      });
      await expect(check()).resolves.toMatchObject({ exists: true, isOwner: false });

      mockMarketSDK.agents.getAgentDetail.mockResolvedValue({
        canEdit: true,
        ownerId: 'tenant-org-account',
      });
      await expect(check()).resolves.toMatchObject({ exists: true, isOwner: true });
    });

    it('grants nothing when Market did not say', async () => {
      mockMarketSDK.agents.getAgentDetail.mockResolvedValue({ ownerId: 999 });

      await expect(check()).resolves.toMatchObject({ exists: true, isOwner: false });
    });

    it('does not ask Market who the requester is', async () => {
      mockMarketSDK.agents.getAgentDetail.mockResolvedValue({ canEdit: true, ownerId: 1 });
      await check();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('says the agent does not exist only when Market says it is not there', async () => {
      mockMarketSDK.agents.getAgentDetail.mockRejectedValue(new MarketAPIError(404, 'Not Found'));

      await expect(check()).resolves.toEqual({
        exists: false,
        isOwner: false,
        originalAgent: null,
      });
    });

    // Reading a refusal as "does not exist" is how a second agent gets published.
    it.each([
      [401, 'INTERNAL_SERVER_ERROR'],
      [403, 'FORBIDDEN'],
      [503, 'SERVICE_UNAVAILABLE'],
    ])('fails, rather than reporting a missing agent, on a Market %s', async (status, code) => {
      mockMarketSDK.agents.getAgentDetail.mockRejectedValue(new MarketAPIError(status, 'no'));

      await expect(check()).rejects.toMatchObject({ code });
    });
  });

  describe('publishOrCreate', () => {
    const publish = () =>
      inTenant(() =>
        agentRouter
          .createCaller({ serverDB: {}, userId: 'user-1' } as any)
          .publishOrCreate({ identifier: 'org-agent', name: 'Org Agent' }),
      );

    it('adds a version to the organization agent its author may edit', async () => {
      mockMarketSDK.agents.getAgentDetail.mockResolvedValue({
        canEdit: true,
        ownerId: 'tenant-org-account',
      });

      await expect(publish()).resolves.toMatchObject({
        identifier: 'org-agent',
        isNewAgent: false,
      });
      expect(mockMarketSDK.agents.createAgent).not.toHaveBeenCalled();
      expect(mockMarketSDK.agents.createAgentVersion).toHaveBeenCalledWith(
        expect.objectContaining({ identifier: 'org-agent' }),
      );
    });

    it.each([
      [403, 'FORBIDDEN'],
      [503, 'SERVICE_UNAVAILABLE'],
    ])('does not publish anything when it cannot find out (Market %s)', async (status, code) => {
      mockMarketSDK.agents.getAgentDetail.mockRejectedValue(new MarketAPIError(status, 'no'));

      await expect(publish()).rejects.toMatchObject({ code });
      expect(mockMarketSDK.agents.createAgent).not.toHaveBeenCalled();
      expect(mockMarketSDK.agents.createAgentVersion).not.toHaveBeenCalled();
    });

    it('publishes a new agent when Market says the identifier is not there', async () => {
      mockMarketSDK.agents.getAgentDetail.mockRejectedValue(new MarketAPIError(404, 'Not Found'));

      const result = await publish();

      expect(result.isNewAgent).toBe(true);
      expect(mockMarketSDK.agents.createAgent).toHaveBeenCalledTimes(1);
    });

    it('publishes a new agent, not a version of someone else’s, when Market does not allow the edit', async () => {
      mockMarketSDK.agents.getAgentDetail.mockResolvedValue({
        canEdit: false,
        ownerId: 'tenant-org-account',
      });

      const result = await publish();

      expect(result.isNewAgent).toBe(true);
      expect(result.identifier).not.toBe('org-agent');
      expect(mockMarketSDK.agents.createAgent).toHaveBeenCalledTimes(1);
    });
  });
});
