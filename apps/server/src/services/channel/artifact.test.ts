// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { channelRuns } from '@/database/schemas/channel';
import type { LobeChatDatabase } from '@/database/type';

import { channelArtifactCapability } from './artifact';

const { detail } = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock('@/database/models/channel', () => ({
  ChannelModel: class {
    detail = detail;
  },
}));
vi.mock('@/server/services/file', () => ({ FileService: class {} }));

describe('Channel artifact public context boundary', () => {
  it('excludes sibling, future-main and unpublished snapshots from both catalogue and invocation', async () => {
    detail.mockResolvedValue({
      threads: [{ id: 'thread', rootSequence: 2 }],
      messages: [
        { id: 'prefix', sequence: 2, threadId: null },
        { id: 'future-main', sequence: 3, threadId: null },
        { id: 'sibling', sequence: 4, threadId: 'other' },
        { id: 'reply', sequence: 5, threadId: 'thread' },
      ],
      runs: ['prefix', 'future-main', 'sibling', 'reply', 'unpublished'].map((id) => ({
        id,
        publishedMessageId: id === 'unpublished' ? null : id,
      })),
      artifacts: ['prefix', 'future-main', 'sibling', 'reply', 'unpublished'].map((runId) => ({
        runId,
      })),
    });
    const capabilities = await channelArtifactCapability({} as LobeChatDatabase, 'owner', {
      channelId: 'channel',
      manifest: { threadId: 'thread', cutoffSequence: 5 },
    } as typeof channelRuns.$inferSelect);
    const parameters = capabilities.tools[0].function.parameters as {
      properties: { runId: { enum: string[] } };
    };
    expect(parameters.properties.runId.enum).toEqual(['prefix', 'reply']);
    for (const runId of ['future-main', 'sibling', 'unpublished'])
      await expect(
        capabilities.toolTransport!.run(
          { arguments: JSON.stringify({ runId }) } as Parameters<
            NonNullable<typeof capabilities.toolTransport>['run']
          >[0],
          {} as Parameters<NonNullable<typeof capabilities.toolTransport>['run']>[1],
        ),
      ).rejects.toThrow('outside');
  });
});
