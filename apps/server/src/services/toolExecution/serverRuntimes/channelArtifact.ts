import { createHash } from 'node:crypto';

import type { LobeChatDatabase } from '@lobechat/database';
import type { BuiltinServerRuntimeOutput, ChannelRunContext } from '@lobechat/types';
import { and, eq } from 'drizzle-orm';

import { channelAudit } from '@/database/privateSchemas/channel';
import {
  CHANNEL_ARTIFACT_MAX_PAGE,
  ChannelArtifactIdentifier,
  type ChannelArtifactReadArgs,
} from '@/server/services/channel/artifactTool';
import { FileService } from '@/server/services/file';

import type { ServerRuntimeRegistration } from './types';

/**
 * Channel snapshot reader. Per-request: the allowlist lives on the run
 * (`context.channelContext.artifactRunIds`, stamped at operation creation), so
 * a model that invents a `runId` outside the enum is refused here regardless
 * of what the manifest advertised.
 */
class ChannelArtifactExecutionRuntime {
  constructor(
    private db: LobeChatDatabase,
    private ownerId: string,
    private channel: ChannelRunContext,
  ) {}

  read = async (args: ChannelArtifactReadArgs): Promise<BuiltinServerRuntimeOutput> => {
    if (!args?.runId || !this.channel.artifactRunIds.includes(args.runId)) {
      return { content: 'Snapshot is outside the authorized public context', success: false };
    }
    const [record] = await this.db
      .select()
      .from(channelAudit)
      .where(
        and(
          eq(channelAudit.channelId, this.channel.channelId),
          eq(channelAudit.id, `chn_artifact_${args.runId}`),
        ),
      );
    if (typeof record?.details.key !== 'string') {
      return { content: 'Snapshot not found', success: false };
    }
    const content = await new FileService(this.db, this.ownerId).getFileContent(record.details.key);
    if (createHash('sha256').update(content).digest('hex') !== record.details.sha256) {
      return { content: 'Snapshot integrity check failed', success: false };
    }
    const offset = Math.max(0, Math.floor(args.offset || 0));
    const length = Math.min(
      CHANNEL_ARTIFACT_MAX_PAGE,
      Math.max(1, Math.floor(args.length || CHANNEL_ARTIFACT_MAX_PAGE)),
    );
    return {
      content: JSON.stringify({
        content: content.slice(offset, offset + length),
        offset,
        sha256: record.details.sha256,
        totalLength: content.length,
      }),
      success: true,
    };
  };
}

export const channelArtifactRuntime: ServerRuntimeRegistration = {
  factory: (context) => {
    if (!context.serverDB) throw new Error('serverDB is required for channel-artifact execution');
    if (!context.userId) throw new Error('userId is required for channel-artifact execution');
    if (!context.channelContext) {
      throw new Error('channel-artifact is only available inside a Channel run');
    }
    return new ChannelArtifactExecutionRuntime(
      context.serverDB,
      context.userId,
      context.channelContext,
    );
  },
  identifier: ChannelArtifactIdentifier,
};
