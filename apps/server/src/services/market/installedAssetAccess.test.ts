import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listBySource, listMarketplaceIdentifiers, queryPlugins } = vi.hoisted(() => ({
  listBySource: vi.fn(),
  listMarketplaceIdentifiers: vi.fn(),
  queryPlugins: vi.fn(),
}));

vi.mock('@/database/models/connector', () => ({
  ConnectorModel: class {
    listMarketplaceIdentifiers = listMarketplaceIdentifiers;
  },
}));

vi.mock('@/database/models/agentSkill', () => ({
  AgentSkillModel: class {
    listBySource = listBySource;
  },
}));

const { resolveRevokedMarketAssets } = await import('./installedAssetAccess');

const downloadUrl = (identifier: string) =>
  `https://market.test/api/v1/skills/${identifier}/download`;
const inTenant = <T>(fn: () => T, tenantId = 'tenant-a') =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

let userSeq = 0;
const setup = (usable: Array<{ identifier: string; type: 'plugin' | 'skill' }>) => {
  const checkAssetAccess = vi.fn(async () => usable);
  const marketService = { checkAssetAccess, getSkillDownloadUrl: downloadUrl };
  const getMarketService = vi.fn(async () => marketService);
  // A fresh user per case: answers are cached per member for 60 seconds.
  const userId = `user_${++userSeq}`;
  return {
    checkAssetAccess,
    getMarketService,
    run: () =>
      inTenant(() =>
        resolveRevokedMarketAssets({
          db: {} as never,
          getMarketService,
          pluginModel: { query: queryPlugins },
          userId,
        }),
      ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  listBySource.mockResolvedValue({
    data: [
      { identifier: 'weekly-report', manifest: { sourceUrl: downloadUrl('weekly-report') } },
      { identifier: 'meeting-minutes', manifest: { sourceUrl: downloadUrl('meeting-minutes') } },
      // GitHub/URL imports are stored with source 'market' too, but are not catalogue assets.
      {
        identifier: 'github.com/acme/skill',
        manifest: { sourceUrl: 'https://github.com/acme/skill' },
      },
    ],
    total: 3,
  });
  queryPlugins.mockResolvedValue([
    { identifier: 'cloud-search', type: 'plugin' },
    { identifier: 'my-local-mcp', type: 'customPlugin' },
  ]);
  listMarketplaceIdentifiers.mockResolvedValue([]);
});

describe('resolveRevokedMarketAssets', () => {
  it('reports installed catalogue assets Market no longer lets the member use', async () => {
    const { checkAssetAccess, run } = setup([{ identifier: 'weekly-report', type: 'skill' }]);

    await expect(run()).resolves.toEqual(['meeting-minutes', 'cloud-search']);
    expect(checkAssetAccess).toHaveBeenCalledWith([
      { identifier: 'weekly-report', type: 'skill' },
      { identifier: 'meeting-minutes', type: 'skill' },
      { identifier: 'cloud-search', type: 'plugin' },
    ]);
  });

  it('checks Market connectors, including copies kept on experts after uninstalling', async () => {
    const { checkAssetAccess, run } = setup([{ identifier: 'weekly-report', type: 'skill' }]);
    // `cloud-search` is installed and also connected; `qa-deepwiki` only survives as an expert's copy.
    listMarketplaceIdentifiers.mockResolvedValue(['cloud-search', 'qa-deepwiki']);

    await expect(run()).resolves.toEqual(['meeting-minutes', 'cloud-search', 'qa-deepwiki']);
    expect(checkAssetAccess).toHaveBeenCalledWith([
      { identifier: 'weekly-report', type: 'skill' },
      { identifier: 'meeting-minutes', type: 'skill' },
      { identifier: 'cloud-search', type: 'plugin' },
      { identifier: 'qa-deepwiki', type: 'plugin' },
    ]);
  });

  it('reuses the answer for the same member within the cache window', async () => {
    const { checkAssetAccess, run } = setup([]);

    await run();
    await run();
    expect(checkAssetAccess).toHaveBeenCalledTimes(1);
  });

  it('keeps installed tools when the check fails', async () => {
    const { checkAssetAccess, run } = setup([]);
    checkAssetAccess.mockRejectedValueOnce(new Error('market down'));

    await expect(run()).resolves.toEqual([]);
  });

  it('does not contact Market without installed catalogue tools or outside a tenant', async () => {
    const { getMarketService, run } = setup([]);
    listBySource.mockResolvedValue({ data: [], total: 0 });
    queryPlugins.mockResolvedValue([{ identifier: 'my-local-mcp', type: 'customPlugin' }]);

    await expect(run()).resolves.toEqual([]);
    await expect(
      resolveRevokedMarketAssets({
        db: {} as never,
        getMarketService,
        pluginModel: { query: queryPlugins },
        userId: 'user_x',
      }),
    ).resolves.toEqual([]);
    expect(getMarketService).not.toHaveBeenCalled();
  });
});
