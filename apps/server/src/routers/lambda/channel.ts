import type { ChannelMemberConfig } from '@lobechat/types';
import { CHANNEL_LIMITS } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ChannelError, ChannelModel } from '@/database/models/channel';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { getChannelArtifactUrl } from '@/server/services/channel/artifact';
import { ChannelDevice } from '@/server/services/channel/device';
import { isChannelEnabled } from '@/server/services/channel/gate';
import { isChannelGatewayReady } from '@/server/services/channel/gateway';
import { resolveChannelMembers } from '@/server/services/channel/members';
import { checkChannelNativeAvailability } from '@/server/services/channel/native/capabilities';
import { watchChannel } from '@/server/services/channel/watch';
import { resolveAttachmentMetadata } from '@/server/services/file/resolveAttachments';

const channelProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  if (ctx.workspaceId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Channels are personal in this release' });
  if (!isChannelEnabled())
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Channel gateway is not configured',
    });
  if (!(await isChannelGatewayReady()))
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Channel service is unavailable',
    });
  const result = await next({ ctx: { channelModel: new ChannelModel(ctx.serverDB, ctx.userId) } });
  if (!result.ok && result.error.cause instanceof ChannelError) {
    throw new TRPCError({ code: result.error.cause.code, message: result.error.cause.message });
  }
  return result;
});

const channelId = z.string().min(1).max(100);
const environment = z.object({
  deviceId: z.string().min(1).max(100),
  workingDirectory: z.string().trim().min(1).max(4000),
});
const memberRevision = z.object({
  channelId,
  memberId: channelId,
  expectedRevision: z.number().int().nonnegative(),
});
const member = z
  .object({
    agentId: z.string().min(1).max(100),
    deviceId: z.string().max(100).optional(),
    workingDirectory: z.string().max(4000).optional(),
  })
  .strict();

async function prepareMembers(
  db: LobeChatDatabase,
  ownerId: string,
  members: { config: ChannelMemberConfig }[],
) {
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
        config.agentId,
      );
    if (config.runtime === 'native') await checkChannelNativeAvailability(db, ownerId, config);
  }
}

export const channelRouter = router({
  availability: authedProcedure.use(serverDatabase).query(async ({ ctx }) => ({
    enabled: !ctx.workspaceId && isChannelEnabled() && (await isChannelGatewayReady()),
  })),
  validateEnvironment: channelProcedure
    .input(environment.extend({ agentId: channelId }).strict())
    .mutation(async ({ ctx, input }) => {
      const [member] = await resolveChannelMembers(ctx.serverDB, ctx.userId, [input]);
      if (member.config.runtime === 'native')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Native local execution is not supported yet',
        });
      await prepareMembers(ctx.serverDB, ctx.userId, [member]);
      return { deviceId: input.deviceId, workingDirectory: member.config.workingDirectory! };
    }),
  pauseMember: channelProcedure
    .input(memberRevision.extend({ onlyIfIdle: z.boolean().optional() }).strict())
    .mutation(({ ctx, input }) =>
      ctx.channelModel.pauseMember(
        input.channelId,
        input.memberId,
        input.expectedRevision,
        input.onlyIfIdle,
      ),
    ),
  resumeMember: channelProcedure
    .input(memberRevision.strict())
    .mutation(({ ctx, input }) =>
      ctx.channelModel.resumeMember(input.channelId, input.memberId, input.expectedRevision),
    ),
  updateEnvironment: channelProcedure
    .input(memberRevision.extend(environment.shape).strict())
    .mutation(async ({ ctx, input }) => {
      const detail = await ctx.channelModel.detail(input.channelId);
      const member = detail.members.find((m) => m.id === input.memberId && m.active);
      if (!member) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
      if (member.config.runtime === 'native')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Native local execution is not supported yet',
        });
      if (!member.executionPaused || member.environmentRevision !== input.expectedRevision)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Member environment changed; reload before editing',
        });
      const workingDirectory = await new ChannelDevice(
        ctx.serverDB,
        ctx.userId,
        input.deviceId,
      ).probe(input.workingDirectory, member.config.runtime, member.config.agentId);
      await ctx.channelModel.updateEnvironment(
        input.channelId,
        input.memberId,
        input.expectedRevision,
        {
          deviceId: input.deviceId,
          workingDirectory,
        },
      );
    }),
  list: channelProcedure.query(({ ctx }) => ctx.channelModel.listWithThreads()),
  rename: channelProcedure
    .input(z.object({ channelId, title: z.string().trim().min(1).max(200) }))
    .mutation(({ ctx, input }) => ctx.channelModel.rename(input.channelId, input.title)),
  archive: channelProcedure
    .input(z.object({ channelId }))
    .mutation(({ ctx, input }) => ctx.channelModel.retire(input.channelId)),
  // Soft deletion retains worker receipts until execution has physically stopped.
  remove: channelProcedure
    .input(z.object({ channelId }))
    .mutation(({ ctx, input }) => ctx.channelModel.retire(input.channelId)),
  removeMember: channelProcedure
    .input(z.object({ channelId, memberId: channelId }))
    .mutation(({ ctx, input }) => ctx.channelModel.retire(input.channelId, input.memberId)),
  addMembers: channelProcedure
    .input(z.object({ channelId, members: z.array(member).min(1).max(CHANNEL_LIMITS.members) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.channelModel.detail(input.channelId);
      const members = await resolveChannelMembers(ctx.serverDB, ctx.userId, input.members);
      await prepareMembers(ctx.serverDB, ctx.userId, members);
      return ctx.channelModel.addMembers(input.channelId, members);
    }),
  resetSession: channelProcedure
    .input(z.object({ channelId, memberId: channelId, threadId: channelId.nullable() }))
    .mutation(({ ctx, input }) =>
      ctx.channelModel.resetSession(input.channelId, input.memberId, input.threadId),
    ),
  detail: channelProcedure.input(z.object({ channelId })).query(async ({ ctx, input }) => {
    const detail = await ctx.channelModel.detail(input.channelId);
    if (detail.channel.archived) throw new TRPCError({ code: 'NOT_FOUND' });
    return detail;
  }),
  page: channelProcedure
    .input(
      z.object({
        channelId,
        threadId: channelId.nullish(),
        before: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = await ctx.channelModel.page(input.channelId, input);
      const attachments = await resolveAttachmentMetadata({
        db: ctx.serverDB,
        userId: ctx.userId,
        fileIds: [...page.messages, ...page.contextMessages].flatMap((message) => message.fileIds),
      });
      return { ...page, attachments };
    }),
  watch: channelProcedure.input(z.object({ channelId })).subscription(async function* ({
    ctx,
    input,
    signal,
  }) {
    yield* watchChannel(
      `${ctx.userId}:${input.channelId}`,
      () => ctx.channelModel.revision(input.channelId),
      signal,
    );
  }),
  create: channelProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(200),
        members: z.array(member).min(CHANNEL_LIMITS.minMembers).max(CHANNEL_LIMITS.members),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const members = await resolveChannelMembers(ctx.serverDB, ctx.userId, input.members);
      await prepareMembers(ctx.serverDB, ctx.userId, members);
      return ctx.channelModel.create(input.title, members);
    }),
  send: channelProcedure
    .input(
      z.object({
        channelId,
        content: z.string().trim().max(100000),
        fileIds: z.array(z.string().min(1).max(100)).max(CHANNEL_LIMITS.attachments).optional(),
        mentions: z.array(z.string()).max(CHANNEL_LIMITS.members),
        mode: z.enum(['normal', 'discussion']).default('normal'),
        maxDiscussionRounds: z
          .number()
          .int()
          .min(1)
          .max(CHANNEL_LIMITS.maxDiscussionRounds)
          .optional(),
        requestKey: z.string().uuid(),
        threadId: channelId.nullish(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.channelModel.send(input.channelId, input)),
  recall: channelProcedure
    .input(z.object({ channelId, messageId: channelId, memberId: channelId }))
    .mutation(({ ctx, input }) =>
      ctx.channelModel.recall(input.channelId, input.messageId, input.memberId),
    ),
  retryRouting: channelProcedure
    .input(z.object({ channelId, messageId: channelId }))
    .mutation(({ ctx, input }) => ctx.channelModel.retryRouting(input.channelId, input.messageId)),
  branch: channelProcedure
    .input(z.object({ channelId, rootMessageId: z.string() }))
    .mutation(({ ctx, input }) => ctx.channelModel.branch(input.channelId, input.rootMessageId)),
  removeThreadFollower: channelProcedure
    .input(z.object({ channelId, threadId: channelId, memberId: channelId }))
    .mutation(({ ctx, input }) =>
      ctx.channelModel.removeThreadFollower(input.channelId, input.threadId, input.memberId),
    ),
  artifact: channelProcedure
    .input(z.object({ channelId, runId: channelId }))
    .query(({ ctx, input }) =>
      getChannelArtifactUrl(ctx.serverDB, ctx.userId, input.channelId, input.runId),
    ),
  approve: channelProcedure
    .input(z.object({ channelId, approvalId: z.string().min(1).max(300), approved: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.channelModel.decideApproval(input.channelId, input.approvalId, input.approved),
    ),
  stop: channelProcedure
    .input(
      z.object({
        channelId,
        scope: z.union([
          z.object({ runId: channelId }),
          z.object({ threadId: channelId.nullable() }),
        ]),
      }),
    )
    .mutation(({ ctx, input }) => ctx.channelModel.stop(input.channelId, input.scope)),
});
