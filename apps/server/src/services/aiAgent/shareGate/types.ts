import type { AgentShareToolGrant } from '@lobechat/types';

import type { AgentShareConfig } from '@/database/schemas';

/**
 * Server-side gate for shared-agent visitor conversations.
 *
 * Built exclusively by the shareChat router after the share access check —
 * never from client input. The gate is applied at operation-build time inside
 * `AiAgentService.execAgent`, so the restricted tool/memory/file surface is
 * snapshotted into the operation state and every later step inherits it
 * without the context engine knowing about shares.
 */
export interface AgentShareGate {
  agentId: string;
  shareConfig: AgentShareConfig;
  /**
   * The `agentShares.id` this run was authorized against — read together with
   * `shareConfig` in the SAME `AgentShareModel.findByShareIdWithAccessCheck`
   * call.
   *
   * "The share row for this agent still exists AND its id still equals
   * `shareId` AND its visibility is still `link`" is exactly the condition
   * "this run's authorization has not been revoked". Every re-validation in
   * the visitor chain (`shareVisitorAbuseGuards`, the per-step runtime
   * re-check) is that one comparison.
   *
   * The visibility half carries the ordinary case: turning sharing off flips
   * the row to `private` and keeps it, so the owner can resume the same link
   * later (`AgentShareModel.updateVisibility`). The id half covers a row that
   * genuinely went away and came back as a different instance — a hard delete
   * (`AgentShareModel.deleteByAgentId`) or an agent delete + recreate.
   */
  shareId: string;
  /**
   * The signed-in visitor driving this run. Recorded on `topics.senderId` and
   * spend-log metadata; the run itself executes as the creator.
   */
  visitorUserId: string;
}

export interface ShareDataToolPermissions {
  allowReadMemory?: boolean;

  knowledgeBaseIds?: string[];

  skillGrants?: string[];
  toolGrants?: AgentShareToolGrant[];
}
