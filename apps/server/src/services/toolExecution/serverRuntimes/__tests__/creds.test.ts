import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketService } from '@/server/services/market';

import { type ToolExecutionContext } from '../../types';
import { credsRuntime, ServerCredsService } from '../creds';

const { getMember } = vi.hoisted(() => ({
  getMember: vi.fn(),
}));

vi.mock('@/database/models/workspaceMember', () => ({
  WorkspaceMemberModel: vi.fn().mockImplementation(function () {
    return { getMember };
  }),
}));

vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn(),
}));

describe('credsRuntime', () => {
  const serverDB = {} as NonNullable<ToolExecutionContext['serverDB']>;

  beforeEach(() => {
    vi.clearAllMocks();
    getMember.mockResolvedValue({ role: 'member' });
  });

  it('signs verified workspace context into the Market trusted-client identity', async () => {
    await credsRuntime.factory({
      serverDB,
      toolManifestMap: {},
      topicId: 'topic-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
    });

    expect(getMember).toHaveBeenCalledWith('workspace-1', 'user-1');
    expect(MarketService).toHaveBeenCalledWith({
      userInfo: expect.objectContaining({ userId: 'user-1', workspaceId: 'workspace-1' }),
    });
  });

  it('rejects workspace context without an active membership', async () => {
    getMember.mockResolvedValue(undefined);

    await expect(
      credsRuntime.factory({
        serverDB,
        toolManifestMap: {},
        userId: 'user-1',
        workspaceId: 'workspace-1',
      }),
    ).rejects.toThrow('Workspace membership is required for workspace Creds execution');
    expect(MarketService).not.toHaveBeenCalled();
  });

  it('fails closed when workspace membership cannot be queried', async () => {
    await expect(
      credsRuntime.factory({
        toolManifestMap: {},
        userId: 'user-1',
        workspaceId: 'workspace-1',
      }),
    ).rejects.toThrow('serverDB is required for workspace Creds execution');
    expect(getMember).not.toHaveBeenCalled();
    expect(MarketService).not.toHaveBeenCalled();
  });

  it('keeps personal runtime identity outside a workspace', async () => {
    await credsRuntime.factory({
      toolManifestMap: {},
      topicId: 'topic-1',
      userId: 'user-1',
    });

    expect(getMember).not.toHaveBeenCalled();
    expect(MarketService).toHaveBeenCalledWith(
      expect.objectContaining({
        userInfo: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
    expect(vi.mocked(MarketService).mock.calls[0][0]?.userInfo?.workspaceId).toBeUndefined();
  });

  it('rejects runtime creation without a user identity', async () => {
    await expect(credsRuntime.factory({ toolManifestMap: {} })).rejects.toThrow(
      'userId is required for Creds execution',
    );
  });

  // `lobe-creds` is already absent from `AGENT_SHARE_ALLOWED_BUILTIN_IDENTIFIERS`,
  // so this runtime should never even be constructed for a share visitor —
  // this is the belt-and-braces backstop in case that allowlist gate is ever
  // bypassed: the sandbox write path must refuse on its own too, since
  // `~/.creds/env` must never receive the creator's decrypted credentials
  // inside a sandbox a visitor's model can run arbitrary shell commands in.
  it('refuses to write credentials into the sandbox for a share-visitor run', async () => {
    vi.mocked(MarketService).mockImplementation(function () {
      return {
        market: {
          creds: {
            inject: vi.fn().mockResolvedValue({
              credentials: { env: { FOO: 'bar' } },
            }),
          },
        },
      } as any;
    });

    const runtime = await credsRuntime.factory({
      agentShareVisitor: { agentId: 'agent-1' } as any,
      serverDB,
      toolManifestMap: {},
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const result = await (runtime as any).injectCredsToSandbox({ keys: ['FOO'] });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('unavailable in shared conversations');
  });
});

describe('ServerCredsService.injectCreds', () => {
  const buildMarketService = (inject = vi.fn()) =>
    ({ market: { creds: { inject } } }) as unknown as MarketService;

  // Regression test: an earlier version of this method took the
  // `credentials.env` map back from market's `/inject-creds` response and
  // wrote it into the sandbox a second time. But that response is already
  // masked for safe display (market itself writes the *real* values into
  // ~/.creds/env server-side when `sandbox` is true) — so the second write
  // appended a masked `export` line after market's real one, and since
  // re-sourcing the file applies `export`s in file order, the masked line
  // silently shadowed the real credential for every later command. The fix
  // is to only forward market's response, never re-write it — this test
  // locks that in by asserting `market.creds.inject` is the only call made
  // and its result is returned untouched.
  it("forwards market.creds.inject's result without writing it into the sandbox again", async () => {
    const injectResult = {
      credentials: { env: { DC_CLI_TOKEN: '8f******vZ' } },
      notFound: [],
      success: true,
    };
    const inject = vi.fn().mockResolvedValue(injectResult);
    const service = new ServerCredsService(buildMarketService(inject), 'workspace-1');

    const result = await service.injectCreds({
      keys: ['dc-cli-token'],
      sandbox: true,
      topicId: 'topic-1',
      userId: 'user-1',
    });

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith({
      keys: ['dc-cli-token'],
      sandbox: true,
      topicId: 'topic-1',
      userId: 'user-1',
    });
    expect(result).toBe(injectResult);
  });
});

// R13: a tenant has no workspace organization. Reads and writes inside a
// workspace fail as that one tool call, with a readable reason; they never fall
// back to the personal credentials.
describe('ServerCredsService inside a tenant workspace', () => {
  const inTenant = <T>(fn: () => T) =>
    runWithTenantScope(
      { session: {}, slug: 'acme', tenantId: 'tenant-a' } as unknown as TenantScope,
      fn,
    );

  const build = () => {
    const personal = {
      get: vi.fn(),
      inject: vi.fn().mockResolvedValue({ success: true }),
      list: vi.fn().mockResolvedValue({ data: [{ id: 1, key: 'PERSONAL' }] }),
    };
    const organizations = { creds: vi.fn() };
    const market = { creds: personal, organizations };
    return { market, organizations, personal };
  };

  it('fails the list with a readable reason and reads no credentials', async () => {
    const { market, organizations, personal } = build();
    const service = new ServerCredsService({ market } as unknown as MarketService, 'workspace-1');

    await expect(inTenant(() => service.listCreds())).rejects.toThrow(
      /Workspace credentials are not available/,
    );
    expect(personal.list).not.toHaveBeenCalled();
    expect(organizations.creds).not.toHaveBeenCalled();
  });

  it('fails a read by key the same way', async () => {
    const { market, personal } = build();
    const service = new ServerCredsService({ market } as unknown as MarketService, 'workspace-1');

    await expect(inTenant(() => service.getByKey('PERSONAL'))).rejects.toThrow(
      /Workspace credentials are not available/,
    );
    expect(personal.list).not.toHaveBeenCalled();
    expect(personal.get).not.toHaveBeenCalled();
  });

  // Market resolved the organization's credentials from the workspaceId in the
  // token. The token no longer carries it, so an inject would pick personal ones.
  it('refuses to inject, so personal credentials never land in the workspace sandbox', async () => {
    const { market, personal } = build();
    const service = new ServerCredsService({ market } as unknown as MarketService, 'workspace-1');

    await expect(
      inTenant(() => service.injectCreds({ keys: ['K'], topicId: 't', userId: 'u' })),
    ).rejects.toThrow(/Workspace credentials are not available/);
    expect(personal.inject).not.toHaveBeenCalled();
  });

  it('surfaces as a failed tool call, not a failed run', async () => {
    const { market } = build();
    const { CredsExecutionRuntime } = await import('@lobechat/builtin-tool-creds/executionRuntime');
    const runtime = new CredsExecutionRuntime(
      new ServerCredsService({ market } as unknown as MarketService, 'workspace-1'),
      { appUrl: 'https://app.test', topicId: 't', userId: 'u' },
    );

    const result = await inTenant(() => (runtime as any).injectCredsToSandbox({ keys: ['K'] }));

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Workspace credentials are not available/);
  });

  it('keeps personal credentials working without a workspace', async () => {
    const { market, personal } = build();
    const service = new ServerCredsService({ market } as unknown as MarketService);

    await expect(inTenant(() => service.listCreds())).resolves.toMatchObject({
      data: [{ key: 'PERSONAL' }],
    });
    expect(personal.list).toHaveBeenCalledTimes(1);
  });
});
