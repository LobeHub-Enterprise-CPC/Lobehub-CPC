import { createHash } from 'node:crypto';

import type { CodexChannelSnapshot } from '@lobechat/heterogeneous-agents/channel';
import { and, eq } from 'drizzle-orm';

import { ChannelModel } from '@/database/models/channel';
import { channelAudit, channelRuns, channels } from '@/database/privateSchemas/channel';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';

import type { ChannelNativeCapabilities } from './native/host';

/** Content-addressed object plus an immutable owner/Run-scoped record. */
export async function saveChannelArtifact(
  db: LobeChatDatabase,
  ownerId: string,
  channelId: string,
  runId: string,
  snapshot: CodexChannelSnapshot,
) {
  if (!snapshot.evidence?.final || !snapshot.physicalStopped)
    throw new Error('Completed workspace snapshot is missing');
  const content = JSON.stringify(snapshot.evidence);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const id = `chn_artifact_${runId}`;
  const [existing] = await db.select().from(channelAudit).where(eq(channelAudit.id, id));
  if (existing) {
    if (existing.details.sha256 !== sha256)
      throw new Error('Workspace snapshot changed after publication');
    return;
  }
  await new ChannelModel(db, ownerId).detail(channelId);
  const key = `channel-artifacts/${ownerId}/${runId}/${sha256}.json`;
  await new FileService(db, ownerId).uploadBuffer(key, Buffer.from(content), 'application/json');
  await db.transaction(async (tx) => {
    const [channel] = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.ownerId, ownerId)))
      .for('update');
    if (!channel || channel.archived) throw new Error('Channel is no longer active');
    const [run] = await tx
      .select()
      .from(channelRuns)
      .where(
        and(
          eq(channelRuns.channelId, channelId),
          eq(channelRuns.id, runId),
          eq(channelRuns.fence, snapshot.fence),
          eq(channelRuns.publicationRevoked, false),
        ),
      )
      .for('update');
    if (!run) throw new Error('Snapshot Run authority was revoked');
    await tx
      .insert(channelAudit)
      .values({
        id,
        channelId,
        event: 'workspace_snapshot',
        targetId: runId,
        details: {
          key,
          sha256,
          baselineCommit: snapshot.evidence!.baseline.commit,
          files: snapshot.evidence!.final!.files.length,
        },
      })
      .onConflictDoNothing();
  });
}

export async function getChannelArtifactUrl(
  db: LobeChatDatabase,
  ownerId: string,
  channelId: string,
  runId: string,
) {
  await new ChannelModel(db, ownerId).detail(channelId);
  const [artifact] = await db
    .select({ details: channelAudit.details })
    .from(channelAudit)
    .innerJoin(channelRuns, eq(channelRuns.id, channelAudit.targetId))
    .where(
      and(eq(channelAudit.channelId, channelId), eq(channelAudit.id, `chn_artifact_${runId}`)),
    );
  if (!artifact || typeof artifact.details.key !== 'string')
    throw new Error('Workspace snapshot not found');
  return {
    url: await new FileService(db, ownerId).createPreSignedUrlForPreview(artifact.details.key, 300),
    sha256: artifact.details.sha256,
  };
}

/** Review only immutable artifacts whose public final is inside this Run's sealed context. */
export async function channelArtifactCapability(
  db: LobeChatDatabase,
  ownerId: string,
  run: typeof channelRuns.$inferSelect,
): Promise<ChannelNativeCapabilities> {
  const detail = await new ChannelModel(db, ownerId).detail(run.channelId);
  const thread = detail.threads.find((item) => item.id === run.manifest.threadId);
  const visible = new Set(
    detail.messages
      .filter(
        (message) =>
          message.sequence <= run.manifest.cutoffSequence &&
          (thread
            ? message.threadId === thread.id ||
              (!message.threadId && message.sequence <= thread.rootSequence)
            : !message.threadId),
      )
      .map((message) => message.id),
  );
  const allowed = detail.artifacts.filter((artifact) =>
    detail.runs.some(
      (source) =>
        source.id === artifact.runId &&
        source.publishedMessageId &&
        visible.has(source.publishedMessageId),
    ),
  );
  const identifier = 'channel-artifact';
  const parameters = {
    type: 'object',
    properties: {
      runId: { type: 'string', enum: allowed.map((artifact) => artifact.runId) },
      offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1, maximum: 20000 },
    },
    required: ['runId'],
    additionalProperties: false,
  };
  if (!allowed.length) return { tools: [], toolManifestMap: {} };
  const description = `Read an immutable workspace snapshot for review. Includes baseline commit, baseline and final diff/file hashes/content, and observed command/test results. This is source evidence, not member claims. Authorized Run IDs: ${allowed.map((artifact) => artifact.runId).join(', ')}. Page through large snapshots using character offset and length.`;
  return {
    tools: [
      {
        type: 'function',
        function: { name: `${identifier}____read____builtin`, description, parameters },
      },
    ],
    toolManifestMap: {
      [identifier]: { identifier, api: [{ name: 'read', description, parameters }] },
    },
    toolTransport: {
      run: async (call) => {
        const args = JSON.parse(call.arguments) as {
          runId: string;
          offset?: number;
          length?: number;
        };
        if (!allowed.some((artifact) => artifact.runId === args.runId))
          throw new Error('Snapshot is outside the authorized public context');
        const [record] = await db
          .select()
          .from(channelAudit)
          .where(
            and(
              eq(channelAudit.channelId, run.channelId),
              eq(channelAudit.id, `chn_artifact_${args.runId}`),
            ),
          );
        if (typeof record?.details.key !== 'string') throw new Error('Snapshot not found');
        const content = await new FileService(db, ownerId).getFileContent(record.details.key);
        if (createHash('sha256').update(content).digest('hex') !== record.details.sha256)
          throw new Error('Snapshot integrity check failed');
        const offset = Math.max(0, Math.floor(args.offset || 0));
        const length = Math.min(20000, Math.max(1, Math.floor(args.length || 20000)));
        return {
          attempts: 1,
          result: {
            success: true,
            content: JSON.stringify({
              sha256: record.details.sha256,
              offset,
              totalLength: content.length,
              content: content.slice(offset, offset + length),
            }),
          },
        };
      },
    },
  };
}
