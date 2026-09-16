// @vitest-environment node
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { channelArtifactRuntime } from '@/server/services/toolExecution/serverRuntimes/channelArtifact';
import type { ToolExecutionContext } from '@/server/services/toolExecution/types';

import { resolveChannelArtifactRunIds } from './artifact';
import { buildChannelArtifactManifest } from './artifactTool';

const { detail, getFileContent } = vi.hoisted(() => ({
  detail: vi.fn(),
  getFileContent: vi.fn(),
}));
vi.mock('@/database/models/channel', () => ({
  ChannelModel: class {
    detail = detail;
  },
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    getFileContent = getFileContent;
  },
}));

const runtimeContext = (record: unknown) => {
  const where = vi.fn().mockResolvedValue(record ? [record] : []);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return {
    context: {
      channelContext: {
        artifactRunIds: ['allowed'],
        channelId: 'channel',
        fence: 1,
        runId: 'current',
      },
      serverDB: { select },
      userId: 'owner',
    } as unknown as ToolExecutionContext,
    where,
  };
};

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

  it('requires channel context when constructing the real runtime', () => {
    expect(() =>
      channelArtifactRuntime.factory({
        serverDB: {} as never,
        toolManifestMap: {},
        userId: 'owner',
      }),
    ).toThrow('only available inside a Channel run');
  });

  it('rejects snapshot content whose hash does not match the audit record', async () => {
    getFileContent.mockResolvedValue('tampered');
    const { context } = runtimeContext({ details: { key: 'snapshot-key', sha256: 'wrong' } });
    const runtime = channelArtifactRuntime.factory(context) as {
      read: (args: { runId: string }) => Promise<unknown>;
    };

    await expect(runtime.read({ runId: 'allowed' })).resolves.toEqual({
      content: 'Snapshot integrity check failed',
      success: false,
    });
  });

  it('reads an allowed snapshot with channel-bound lookup and bounded pagination', async () => {
    const content = '0123456789';
    const sha256 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const hash = Buffer.from(sha256).toString('hex');
    getFileContent.mockResolvedValue(content);
    const { context, where } = runtimeContext({ details: { key: 'snapshot-key', sha256: hash } });
    const runtime = channelArtifactRuntime.factory(context) as {
      read: (args: { length?: number; offset?: number; runId: string }) => Promise<any>;
    };

    const result = await runtime.read({ length: 4, offset: 3, runId: 'allowed' });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      content: '3456',
      offset: 3,
      sha256: hash,
      totalLength: 10,
    });
    expect(getFileContent).toHaveBeenCalledWith('snapshot-key');
    expect(where).toHaveBeenCalledOnce();
    const predicate = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(predicate.sql).toBe('("channel_audit"."channel_id" = $1 and "channel_audit"."id" = $2)');
    expect(predicate.params).toEqual(['channel', 'chn_artifact_allowed']);
  });
});
