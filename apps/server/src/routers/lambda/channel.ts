import { setTimeout as delay } from 'node:timers/promises';

import type { ChannelMemberConfig } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ChannelError, ChannelModel } from '@/database/models/channel';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { getChannelArtifactUrl } from '@/server/services/channel/artifact';
import { ChannelDevice } from '@/server/services/channel/device';
import { isChannelEnabled } from '@/server/services/channel/gate';
import { resolveChannelMembers } from '@/server/services/channel/members';
import { loadChannelNativeCapabilities } from '@/server/services/channel/native/capabilities';

const channelProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  if (ctx.workspaceId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Channels are personal in this release' });
  if (!isChannelEnabled(ctx.userId))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Channel preview is not enabled for this account',
    });
  const result = await next({ ctx: { channelModel: new ChannelModel(ctx.serverDB, ctx.userId) } });
  if (!result.ok && result.error.cause instanceof ChannelError) {
    throw new TRPCError({ code: result.error.cause.code, message: result.error.cause.message });
  }
  return result;
});

const channelId = z.string().min(1).max(100);
const member = z
  .object({
    agentId: z.string().min(1).max(100),
    deviceId: z.string().max(100).optional(),
    workingDirectory: z.string().max(4000).optional(),
  })
  .strict();

async function validateMembers(
  db: LobeChatDatabase,
  ownerId: string,
  members: { config: ChannelMemberConfig }[],
) {
  const devices = new Set(members.map((member) => member.config.deviceId).filter(Boolean));
  const directories = new Set(
    members.map((member) => member.config.workingDirectory).filter(Boolean),
  );
  if (devices.size > 1 || directories.size > 1)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A Channel uses one device and workspace',
    });
  for (const member of members) {
    const config = member.config;
    if (
      (config.deviceId && !config.workingDirectory) ||
      (!config.deviceId && config.workingDirectory) ||
      (config.runtime !== 'native' && !config.deviceId)
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'An execution device and authorized workspace are required together',
      });
    if (config.deviceId && config.workingDirectory)
      config.workingDirectory = await new ChannelDevice(db, ownerId, config.deviceId).probe(
        config.workingDirectory,
        config.runtime,
      );
    if (config.runtime === 'native') await loadChannelNativeCapabilities(db, ownerId, config);
  }
}

export const channelRouter = router({
  availability: authedProcedure.query(({ ctx }) => ({
    enabled: !ctx.workspaceId && isChannelEnabled(ctx.userId),
  })),
  list: channelProcedure.query(({ ctx }) => ctx.channelModel.list()),
  archive: channelProcedure
    .input(z.object({ channelId }))
    .mutation(({ ctx, input }) => ctx.channelModel.retire(input.channelId)),
  removeMember: channelProcedure
    .input(z.object({ channelId, memberId: z.string() }))
    .mutation(({ ctx, input }) => ctx.channelModel.retire(input.channelId, input.memberId)),
  addMembers: channelProcedure
    .input(z.object({ channelId, members: z.array(member).min(1).max(4) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.channelModel.detail(input.channelId);
      const members = await resolveChannelMembers(ctx.serverDB, ctx.userId, input.members);
      await validateMembers(ctx.serverDB, ctx.userId, members);
      return ctx.channelModel.addMembers(input.channelId, members);
    }),
  resetSession: channelProcedure
    .input(z.object({ channelId, memberId: z.string(), threadId: z.string().nullable() }))
    .mutation(({ ctx, input }) =>
      ctx.channelModel.resetSession(input.channelId, input.memberId, input.threadId),
    ),
  detail: channelProcedure
    .input(z.object({ channelId }))
    .query(({ ctx, input }) => ctx.channelModel.detail(input.channelId)),
  watch: channelProcedure.input(z.object({ channelId })).subscription(async function* ({
    ctx,
    input,
    signal,
  }) {
    let previous = '';
    const deadline = Date.now() + 15_000;
    // Stream canonical snapshots on change; reconnect always starts with a fresh snapshot.
    // The bounded sampling also sees transitions made by a separate Worker process.
    // Bound connection lifetime: Desktop proxies may not forward a renderer cancellation.
    while (!signal?.aborted && Date.now() < deadline) {
      const detail = await ctx.channelModel.detail(input.channelId);
      const fingerprint = JSON.stringify(detail);
      if (fingerprint !== previous) {
        previous = fingerprint;
        yield detail;
      }
      await delay(400, undefined, { signal }).catch((error) => {
        if (!signal?.aborted) throw error;
      });
    }
  }),
  create: channelProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(200),
        members: z.array(member).min(1).max(4),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const members = await resolveChannelMembers(ctx.serverDB, ctx.userId, input.members);
      await validateMembers(ctx.serverDB, ctx.userId, members);
      return ctx.channelModel.create(input.title, members);
    }),
  send: channelProcedure
    .input(
      z.object({
        channelId,
        content: z.string().trim().min(1).max(100000),
        mentions: z.array(z.string()).max(4),
        requestKey: z.string().uuid(),
        threadId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.channelModel.send(input.channelId, input)),
  recall: channelProcedure
    .input(z.object({ channelId, messageId: z.string(), memberId: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.channelModel.recall(input.channelId, input.messageId, input.memberId),
    ),
  retryRouting: channelProcedure
    .input(z.object({ channelId, messageId: z.string() }))
    .mutation(({ ctx, input }) => ctx.channelModel.retryRouting(input.channelId, input.messageId)),
  branch: channelProcedure
    .input(z.object({ channelId, rootMessageId: z.string() }))
    .mutation(({ ctx, input }) => ctx.channelModel.branch(input.channelId, input.rootMessageId)),
  artifact: channelProcedure
    .input(z.object({ channelId, runId: z.string() }))
    .query(({ ctx, input }) =>
      getChannelArtifactUrl(ctx.serverDB, ctx.userId, input.channelId, input.runId),
    ),
  approve: channelProcedure
    .input(z.object({ channelId, approvalId: z.string(), approved: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.channelModel.decideApproval(input.channelId, input.approvalId, input.approved),
    ),
  stop: channelProcedure
    .input(
      z.object({
        channelId,
        scope: z.union([
          z.object({ runId: z.string() }),
          z.object({ threadId: z.string().nullable() }),
        ]),
      }),
    )
    .mutation(({ ctx, input }) => ctx.channelModel.stop(input.channelId, input.scope)),
});
