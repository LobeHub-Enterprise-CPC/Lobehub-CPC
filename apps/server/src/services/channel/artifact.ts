import { createHash } from 'node:crypto';

import type { CodexChannelSnapshot } from '@lobechat/heterogeneous-agents/channel';
import { and, eq } from 'drizzle-orm';

import { ChannelModel } from '@/database/models/channel';
import { channelAudit, channelRuns, channels } from '@/database/privateSchemas/channel';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';

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

/** Runs whose published snapshot is inside this Run's sealed public context; nothing else is readable. */
export async function resolveChannelArtifactRunIds(
  db: LobeChatDatabase,
  ownerId: string,
  run: Pick<typeof channelRuns.$inferSelect, 'channelId' | 'manifest'>,
): Promise<string[]> {
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
  return detail.artifacts
    .filter((artifact) =>
      detail.runs.some(
        (source) =>
          source.id === artifact.runId &&
          source.publishedMessageId &&
          visible.has(source.publishedMessageId),
      ),
    )
    .map((artifact) => artifact.runId);
}
