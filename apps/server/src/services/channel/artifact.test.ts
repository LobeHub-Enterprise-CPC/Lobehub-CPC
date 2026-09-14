// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { channelArtifactRuntime } from '@/server/services/toolExecution/serverRuntimes/channelArtifact';
import type { ToolExecutionContext } from '@/server/services/toolExecution/types';

import { resolveChannelArtifactRunIds } from './artifact';
import { buildChannelArtifactManifest } from './artifactTool';

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
    const allowed = await resolveChannelArtifactRunIds({} as LobeChatDatabase, 'owner', {
      channelId: 'channel',
      manifest: { threadId: 'thread', cutoffSequence: 5 } as never,
    });
    expect(allowed).toEqual(['prefix', 'reply']);
    const manifest = buildChannelArtifactManifest(allowed)!;
    expect(manifest.api[0].parameters.properties.runId.enum).toEqual(['prefix', 'reply']);
    expect(buildChannelArtifactManifest([])).toBeUndefined();

    // Invocation re-checks the run's allowlist; the enum is advisory to the model only.
    const runtime = channelArtifactRuntime.factory({
      serverDB: { select: vi.fn() } as never,
      userId: 'owner',
      channelContext: { artifactRunIds: allowed, channelId: 'channel', fence: 1, runId: 'run' },
    } as unknown as ToolExecutionContext) as {
      read: (args: { runId: string }) => Promise<unknown>;
    };
    for (const runId of ['future-main', 'sibling', 'unpublished'])
      await expect(runtime.read({ runId })).resolves.toMatchObject({
        success: false,
        content: expect.stringContaining('outside'),
      });
  });
});
