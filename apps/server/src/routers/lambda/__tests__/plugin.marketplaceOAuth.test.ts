// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorModel } from '@/database/models/connector';
import { PluginModel } from '@/database/models/plugin';

import { pluginRouter } from '../plugin';

vi.mock('@/database/models/connector', () => ({ ConnectorModel: vi.fn() }));
vi.mock('@/database/models/plugin', () => ({ PluginModel: vi.fn() }));
vi.mock('@/business/server/trpc-middlewares/workspaceAuth', async () => {
  const { trpc } = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  return { wsCompatProcedure: trpc.procedure };
});
vi.mock('@/business/server/trpc-middlewares/rbacPermission', async () => {
  const { trpc } = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  return { withScopedPermission: () => trpc.middleware(async (opts: any) => opts.next()) };
});
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: async (opts: any) => opts.next(),
}));

describe('marketplace OAuth plugin lifecycle', () => {
  const plugin = { findById: vi.fn(), delete: vi.fn(), update: vi.fn() };
  const connector = { findById: vi.fn(), delete: vi.fn() };
  const tx = {};
  const transaction = vi.fn(async (fn: (db: unknown) => unknown) => fn(tx));
  const caller = (workspaceId?: string) =>
    pluginRouter.createCaller({
      serverDB: { transaction },
      userId: 'owner',
      workspaceId,
      workspaceRole: 'member',
    } as any);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(PluginModel).mockImplementation(function () {
      return plugin as any;
    });
    vi.mocked(ConnectorModel).mockImplementation(function () {
      return connector as any;
    });
    plugin.findById.mockResolvedValue({
      userId: 'owner',
      customParams: { oauthConnectorId: 'conn' },
    });
    connector.findById.mockResolvedValue({
      id: 'conn',
      userId: 'owner',
      identifier: 'docs',
      sourceType: 'marketplace',
      metadata: { marketplaceOAuth: true },
    });
  });

  it('deletes the exact managed connector and installation marker in one transaction', async () => {
    await caller().removePlugin({ id: 'docs' });
    expect(transaction).toHaveBeenCalledOnce();
    expect(ConnectorModel).toHaveBeenCalledWith(tx, 'owner', undefined);
    expect(connector.delete).toHaveBeenCalledWith('conn');
    expect(plugin.delete).toHaveBeenCalledWith('docs');
  });

  it('does not delete an unrelated connector referenced by an invalid marker', async () => {
    connector.findById.mockResolvedValue({
      id: 'conn',
      identifier: 'other',
      sourceType: 'custom',
    });
    await caller().removePlugin({ id: 'docs' });
    expect(connector.delete).not.toHaveBeenCalled();
    expect(plugin.delete).toHaveBeenCalledWith('docs');
  });

  it('rejects removal of another workspace member’s managed connector', async () => {
    connector.findById.mockResolvedValue({
      id: 'conn',
      userId: 'another',
      identifier: 'docs',
      sourceType: 'marketplace',
      metadata: { marketplaceOAuth: true },
    });
    await expect(caller('workspace').removePlugin({ id: 'docs' })).rejects.toThrow(
      'Only the creator',
    );
    expect(connector.delete).not.toHaveBeenCalled();
    expect(plugin.delete).not.toHaveBeenCalled();
  });

  it('replaces an existing legacy installation with the OAuth connector reference', async () => {
    await caller().createOrInstallPlugin({
      identifier: 'docs',
      type: 'plugin',
      manifest: { api: [] },
      customParams: { oauthConnectorId: 'conn' },
    });
    expect(plugin.update).toHaveBeenCalledWith('docs', {
      customParams: { oauthConnectorId: 'conn' },
      manifest: { api: [] },
    });
  });
});
