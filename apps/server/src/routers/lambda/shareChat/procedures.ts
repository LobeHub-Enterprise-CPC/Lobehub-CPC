import { z } from 'zod';

import { authedProcedure } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { assertAgentShareVisitorEnabled } from '../_helpers/agentShareFeatureGate';

/**
 * Read-only visitor access to shared agents (Agent Share). Visitor execution is
 * unsupported on this deployment.
 *
 * All procedures authenticate the VISITOR (ctx.userId) but read rows in the
 * Agent's owning scope: topics/messages carry the creator's userId plus the
 * Agent's workspaceId when present, and `topics.senderId = visitor` for
 * scoping. Every read is therefore manually authorized: resolve the share via
 * `resolveLinkShareOrThrow`, then require
 * `topic.senderId === visitor && topic.agentId === share.agentId`
 * (`findVisitorTopicOrThrow`).
 *
 * Workspace identity is resolved from the share row, never from visitor
 * headers.
 */
export const shareChatProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  // Visitor access depends on deployment support and share permissions,
  // not the publishing rollout flag.
  assertAgentShareVisitorEnabled();

  return opts.next();
});

export const ShareTopicScopeSchema = z.object({
  shareId: z.string(),
  topicId: z.string(),
});
