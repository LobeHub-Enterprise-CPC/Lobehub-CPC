// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { channelRouter } from './channel';

const { list, preference } = vi.hoisted(() => ({ list: vi.fn(), preference: vi.fn() }));
const { page, send, metadata } = vi.hoisted(() => ({
  page: vi.fn(),
  send: vi.fn(),
  metadata: vi.fn(),
}));
vi.mock('@/server/services/file/resolveAttachments', () => ({
  resolveAttachmentMetadata: metadata,
}));
// Authentication is tested by the shared middleware. Exercise the real Channel
// router and gates with an already-authenticated context, without a database.
vi.mock('@/libs/trpc/lambda', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC
    .context<{ serverDB: unknown; userId: string; workspaceId?: string }>()
    .create();
  return { authedProcedure: t.procedure, router: t.router };
});
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: ({ next }: { next: () => unknown }) => next(),
}));
vi.mock('@/database/models/channel', () => ({
  ChannelError: class extends Error {},
  ChannelModel: class {
    listWithThreads = list;
    page = page;
    send = send;
  },
}));
vi.mock('@/database/models/user', () => ({
  UserModel: class {
    getUserPreference = preference;
  },
}));
vi.mock('@/server/services/channel/artifact', () => ({ getChannelArtifactUrl: vi.fn() }));
vi.mock('@/server/services/channel/device', () => ({ ChannelDevice: vi.fn() }));
vi.mock('@/server/services/channel/members', () => ({ resolveChannelMembers: vi.fn() }));
vi.mock('@/server/services/channel/native/capabilities', () => ({
  checkChannelNativeAvailability: vi.fn(),
}));
vi.mock('@/server/services/channel/watch', () => ({ watchChannel: vi.fn() }));

const caller = (workspaceId?: string) =>
  channelRouter.createCaller({ serverDB: {}, userId: 'owner', workspaceId } as Parameters<
    typeof channelRouter.createCaller
  >[0]);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CHANNEL_GATEWAY_URL', 'http://channel-worker:3211');
  vi.stubEnv('CHANNEL_ALLOWED_USER_IDS', 'owner');
  preference.mockResolvedValue({ lab: { enableChannel: true } });
  list.mockResolvedValue([{ id: 'owned-channel' }]);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => Response.json({ status: 'ready' })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Channel service opt-in at the API boundary', () => {
  it('accepts attachment-only sends and resolves metadata for both the page and thread root', async () => {
    await caller().send({
      channelId: 'channel',
      content: '',
      fileIds: ['doc'],
      mentions: [],
      requestKey: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(send).toHaveBeenCalledWith(
      'channel',
      expect.objectContaining({ content: '', fileIds: ['doc'] }),
    );
    page.mockResolvedValue({
      messages: [{ fileIds: ['doc'] }],
      contextMessages: [{ fileIds: ['root-image'] }],
    });
    metadata.mockResolvedValue([{ id: 'doc', name: 'Report' }]);
    const result = await caller().page({ channelId: 'channel', threadId: 'thread' });
    expect(metadata).toHaveBeenCalledWith({
      db: {},
      userId: 'owner',
      fileIds: ['doc', 'root-image'],
    });
    expect(result.attachments).toEqual([{ id: 'doc', name: 'Report' }]);
  });

  it('hides availability and rejects direct API calls when URL is absent', async () => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', '');
    vi.stubEnv('ENABLE_CHANNEL', '1');
    expect(await caller().availability()).toEqual({ enabled: false });
    await expect(caller().list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetch).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects work when the configured service is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
    expect(await caller().availability()).toEqual({ enabled: false });
    await expect(caller().list()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(list).not.toHaveBeenCalled();
  });

  it('serves the authenticated owner only after the service is ready', async () => {
    expect(await caller().availability()).toEqual({ enabled: true });
    expect(await caller().list()).toEqual([{ id: 'owned-channel' }]);
    expect(list).toHaveBeenCalledOnce();
    expect(await caller('workspace').availability()).toEqual({ enabled: false });
    await expect(caller('workspace').list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(list).toHaveBeenCalledOnce();
  });
});
