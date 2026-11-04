import type { LobeChatDatabase } from '@lobechat/database';
import {
  channelJobs,
  channelMembers,
  channelRuns,
  channels,
} from '@lobechat/database/privateSchemas';
import { requireTenantScope } from '@lobechat/database/tenant';
import { and, eq } from 'drizzle-orm';

import { isChannelEnabled } from '@/server/services/channel/gate';

import type { GatewayChannelSource } from './types';
import { GatewayAuthorizationError } from './wire';

const deny = (): never => {
  throw new GatewayAuthorizationError('UNAUTHORIZED');
};

/** Recheck the exact queued job or execution receipt on dispatch and result authorization. */
export const assertChannelGatewaySource = async (
  source: GatewayChannelSource,
  db: LobeChatDatabase,
) => {
  if (source.tenantId !== requireTenantScope().tenantId) deny();
  if ('jobId' in source) {
    if (source.apiName !== 'channelProbe') deny();
    const [row] = await db
      .select({
        status: channelJobs.status,
        ownerId: channels.ownerId,
        archived: channels.archived,
        active: channelMembers.active,
        paused: channelMembers.executionPaused,
        revision: channelMembers.environmentRevision,
        config: channelMembers.config,
      })
      .from(channelJobs)
      .innerJoin(channels, eq(channels.id, channelJobs.channelId))
      .innerJoin(
        channelMembers,
        and(
          eq(channelMembers.id, channelJobs.memberId),
          eq(channelMembers.channelId, channelJobs.channelId),
        ),
      )
      .where(eq(channelJobs.id, source.jobId))
      .limit(1);
    if (
      !row ||
      row.ownerId !== source.subject ||
      row.status !== 'queued' ||
      row.archived ||
      !row.active ||
      row.paused ||
      row.revision !== source.environmentRevision ||
      row.config.deviceId !== source.deviceId ||
      !(await isChannelEnabled(source.subject))
    )
      deny();
    return;
  }
  const [row] = await db
    .select({
      run: channelRuns,
      ownerId: channels.ownerId,
      archived: channels.archived,
      active: channelMembers.active,
      paused: channelMembers.executionPaused,
      revision: channelMembers.environmentRevision,
    })
    .from(channelRuns)
    .innerJoin(channels, eq(channels.id, channelRuns.channelId))
    .innerJoin(
      channelMembers,
      and(
        eq(channelMembers.id, channelRuns.memberId),
        eq(channelMembers.channelId, channelRuns.channelId),
      ),
    )
    .where(eq(channelRuns.id, source.runId))
    .limit(1);
  if (
    !row ||
    row.ownerId !== source.subject ||
    row.run.executionFence !== source.fence ||
    row.run.executionConfig?.deviceId !== source.deviceId
  )
    deny();
  // Inspection and cancellation must remain possible after archiving, revocation,
  // environment changes or logical writer isolation. They cannot start another turn.
  if (source.apiName === 'channelInspect' || source.apiName === 'channelStop') return;
  if (
    !['channelProbe', 'channelStart'].includes(source.apiName) ||
    row.run.status !== 'starting' ||
    row.run.publicationRevoked ||
    row.run.writerReleased ||
    row.run.physicalStopped ||
    row.archived ||
    !row.active ||
    row.paused ||
    row.revision !== row.run.environmentRevision ||
    !(await isChannelEnabled(source.subject))
  )
    deny();
};
