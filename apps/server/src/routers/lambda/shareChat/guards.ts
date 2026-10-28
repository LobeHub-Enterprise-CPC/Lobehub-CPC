import { TRPCError } from '@trpc/server';

import { AgentShareModel } from '@/database/models/agentShare';
import type { TopicModel } from '@/database/models/topic';
import type { LobeChatDatabase } from '@/database/type';

/**
 * Resolve a `link` share for the visitor read paths.
 *
 * Stricter than the plain `findByShareIdWithAccessCheck`: that helper lets the
 * OWNER through on a `private` share (so they can preview their own unpublished
 * page), but visitor conversations are only readable on a link share.
 */
export const resolveLinkShareOrThrow = async (
  db: LobeChatDatabase,
  shareId: string,
  viewerId: string,
) => {
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
export const findVisitorTopicOrThrow = async (
  topicModel: TopicModel,
  params: { agentId: string; topicId: string; visitorUserId: string },
) => {
  const topic = await topicModel.findById(params.topicId);

  if (!topic || topic.senderId !== params.visitorUserId || topic.agentId !== params.agentId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Topic not found' });
  }

  return topic;
};
