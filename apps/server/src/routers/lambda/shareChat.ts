import { agentShareDocumentAccessScope, agentShareWorkAccessScope } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { AgentShareModel } from '@/database/models/agentShare';
import { DocumentModel } from '@/database/models/document';
import { MessageModel } from '@/database/models/message';
import { TopicModel } from '@/database/models/topic';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { FileService } from '@/server/services/file';

import { assertAgentShareVisitorEnabled } from './_helpers/agentShareFeatureGate';

const shareChatProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  assertAgentShareVisitorEnabled();
  return opts.next();
});
const ShareTopicScopeSchema = z.object({ shareId: z.string(), topicId: z.string() });

const resolveLinkShareOrThrow = async (db: LobeChatDatabase, shareId: string, viewerId: string) => {
  const share = await AgentShareModel.findByShareIdWithAccessCheck(db, shareId, viewerId);

  if (share.visibility !== 'link') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This share is private' });
  }

  return share;
};

/**
 * Resolve a visitor-owned share topic or fail closed. The topic row belongs to
 * the creator (creator-scoped TopicModel), so the senderId + agentId match is
 * the ONLY thing standing between a visitor and the creator's other topics.
 */
const findVisitorTopicOrThrow = async (
  topicModel: TopicModel,
  params: { agentId: string; topicId: string; visitorUserId: string },
) => {
  const topic = await topicModel.findById(params.topicId);

  if (!topic || topic.senderId !== params.visitorUserId || topic.agentId !== params.agentId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Topic not found' });
  }

  return topic;
};

/** Read-only access to previously shared conversations. Visitor execution is unsupported. */
export const shareChatRouter = router({
  getDocument: shareChatProcedure
    .input(ShareTopicScopeSchema.extend({ documentId: z.string() }))
    .query(async ({ input, ctx }) => {
      const share = await resolveLinkShareOrThrow(ctx.serverDB, input.shareId, ctx.userId);

      const topicModel = new TopicModel(
        ctx.serverDB,
        share.ownerId,
        share.workspaceId ?? undefined,
        undefined,
        { includeShareVisitor: true },
      );
      await findVisitorTopicOrThrow(topicModel, {
        agentId: share.agentId,
        topicId: input.topicId,
        visitorUserId: ctx.userId,
      });

      const documentModel = new DocumentModel(
        ctx.serverDB,
        share.ownerId,
        share.workspaceId ?? undefined,
        undefined,
        agentShareDocumentAccessScope({
          shareId: share.shareId,
          topicId: input.topicId,
          visitorUserId: ctx.userId,
        }),
      );
      const document = await documentModel.findById(input.documentId);
      if (!document) throw new TRPCError({ code: 'NOT_FOUND', message: 'Document not found' });

      // Narrow projection: no metadata / source / owner columns cross the
      // share boundary — the visitor only needs what the read-only viewer shows.
      return {
        content: document.content,
        fileType: document.fileType,
        id: document.id,
        title: document.title,
        updatedAt: document.updatedAt,
      };
    }),

  getMessages: shareChatProcedure
    .input(ShareTopicScopeSchema.extend({ includeFileWorks: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const share = await resolveLinkShareOrThrow(ctx.serverDB, input.shareId, ctx.userId);

      const topicModel = new TopicModel(
        ctx.serverDB,
        share.ownerId,
        share.workspaceId ?? undefined,
        undefined,
        { includeShareVisitor: true },
      );
      await findVisitorTopicOrThrow(topicModel, {
        agentId: share.agentId,
        topicId: input.topicId,
        visitorUserId: ctx.userId,
      });

      const messageModel = new MessageModel(
        ctx.serverDB,
        share.ownerId,
        share.workspaceId ?? undefined,
        undefined,
        { includeShareVisitor: true },
      );
      const fileService = new FileService(
        ctx.serverDB,
        share.ownerId,
        share.workspaceId ?? undefined,
      );

      // queryForVisitor strips the creator's `sender` identity, and — unless the
      // share opts in via `showModelInfo` / `showErrorDetails` — the spend/model
      // snapshot and raw error payload too. Share messages persist under the
      // CREATOR's account (see the module doc above), so the raw `query()` result
      // would otherwise leak the creator's account identity to the visitor.
      return messageModel.queryForVisitor(
        { includeFileWorks: input.includeFileWorks, topicId: input.topicId },
        {
          postProcessUrl: (path, file) => fileService.getFileAccessUrl({ id: file.id, url: path }),
          redaction: {
            showErrorDetails: share.shareConfig.showErrorDetails,
            showModelInfo: share.shareConfig.showModelInfo,
          },
          // Work summaries are assembled under the visitor's OWN share scope:
          // only Works registered from this share topic resolve, never the
          // creator's ordinary Works (see `workMatchesAccessScope`).
          //
          // Gated on the client's `includeFileWorks` opt-in: pre-Works clients
          // (rolling deploys, cached sessions, lagging desktop builds) never
          // send it and have no share-aware open handler for the cards, so
          // they keep the old Work-free response instead of dead cards.
          workAccessScope: input.includeFileWorks
            ? agentShareWorkAccessScope({
                shareId: share.shareId,
                topicId: input.topicId,
                visitorUserId: ctx.userId,
              })
            : undefined,
        },
      );
    }),

  getTopics: shareChatProcedure
    .input(z.object({ shareId: z.string() }))
    .query(async ({ input, ctx }) => {
      const share = await resolveLinkShareOrThrow(ctx.serverDB, input.shareId, ctx.userId);

      // The list is intentionally NOT bounded by the share's live
      // `maxTopicsPerVisitor`: that cap gates ADMISSION of new topics (the
      // COUNT check in `execAgent` above), and a creator may lower it below
      // what a visitor already created. Tying the page size to it would hide
      // those older conversations with no pagination or deep link to reach
      // them, so the model applies its own fixed, generous list bound instead.
      const topicModel = new TopicModel(
        ctx.serverDB,
        share.ownerId,
        share.workspaceId ?? undefined,
        undefined,
        { includeShareVisitor: true },
      );
      return topicModel.queryBySender({
        agentId: share.agentId,
        senderId: ctx.userId,
      });
    }),
});
export type ShareChatRouter = typeof shareChatRouter;
