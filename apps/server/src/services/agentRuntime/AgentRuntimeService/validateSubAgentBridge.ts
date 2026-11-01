import { eq } from 'drizzle-orm';

import { agentSubAgentBridges } from '@/database/privateSchemas';
import { agentOperations } from '@/database/schemas/agentOperations';
import { messagePlugins } from '@/database/schemas/message';
import { threads } from '@/database/schemas/topic';

import type { SubAgentBridgeParams } from '../types';
import type { AgentRuntimeServiceContext } from './types';

export type SubAgentBridgeRejection =
  | 'binding_missing'
  | 'binding_settled'
  | 'stale_generation'
  | 'batch_mismatch'
  | 'tool_not_pending'
  | 'parent_not_waiting'
  | 'ownership_mismatch';

export type SubAgentBridgeValidation =
  { allowed: true } | { allowed: false; reason: SubAgentBridgeRejection };

/** Verify the durable identity and the parent's current wait before any bridge side effects. */
export async function validateSubAgentBridge(
  deps: Pick<
    AgentRuntimeServiceContext,
    'coordinator' | 'messageModel' | 'serverDB' | 'userId' | 'workspaceId' | 'includeShareVisitor'
  >,
  params: Pick<
    SubAgentBridgeParams,
    'operationId' | 'parentOperationId' | 'threadId' | 'toolMessageId'
  >,
): Promise<SubAgentBridgeValidation> {
  const { serverDB: db } = deps;
  const [binding] = await db
    .select()
    .from(agentSubAgentBridges)
    .where(eq(agentSubAgentBridges.childOperationId, params.operationId))
    .limit(1);
  if (!binding) return { allowed: false, reason: 'binding_missing' };

  if (
    binding.parentOperationId !== params.parentOperationId ||
    binding.threadId !== params.threadId ||
    binding.toolMessageId !== params.toolMessageId ||
    binding.userId !== deps.userId ||
    binding.workspaceId !== (deps.workspaceId ?? null) ||
    binding.includeShareVisitor !== (deps.includeShareVisitor ?? false)
  ) {
    return { allowed: false, reason: 'ownership_mismatch' };
  }

  if (binding.status !== 'pending') return { allowed: false, reason: 'binding_settled' };

  const [child] = await db
    .select()
    .from(agentOperations)
    .where(eq(agentOperations.id, params.operationId))
    .limit(1);
  const [parent] = await db
    .select()
    .from(agentOperations)
    .where(eq(agentOperations.id, binding.parentOperationId))
    .limit(1);
  const [thread] = await db.select().from(threads).where(eq(threads.id, binding.threadId)).limit(1);
  if (
    !child ||
    !parent ||
    !thread ||
    child.parentOperationId !== binding.parentOperationId ||
    child.threadId !== binding.threadId ||
    [child, parent, thread].some(
      (row) => row.userId !== binding.userId || row.workspaceId !== binding.workspaceId,
    )
  ) {
    return { allowed: false, reason: 'ownership_mismatch' };
  }
  if (
    thread.metadata?.runToken !== binding.childRunToken ||
    (thread.metadata?.operationId && thread.metadata.operationId !== params.operationId)
  ) {
    return { allowed: false, reason: 'stale_generation' };
  }
  const message = await deps.messageModel.findById(binding.toolMessageId);
  if (!message || message.parentId !== binding.waitingBatchId) {
    return { allowed: false, reason: 'batch_mismatch' };
  }
  if (parent.status === 'running' || parent.status === 'idle') {
    return { allowed: false, reason: 'parent_not_waiting' };
  }
  const state = await deps.coordinator.loadAgentState(binding.parentOperationId);
  if (
    !state ||
    state.status !== 'waiting_for_async_tool' ||
    parent.status !== 'waiting_for_async_tool'
  ) {
    return { allowed: false, reason: 'tool_not_pending' };
  }
  const [plugin] = await db
    .select()
    .from(messagePlugins)
    .where(eq(messagePlugins.id, binding.toolMessageId))
    .limit(1);
  const callId = plugin?.toolCallId;
  if (
    !callId ||
    !state.pendingToolsCalling?.some((tool) => tool.id === callId) ||
    (state.pendingToolMessageIds?.[callId] &&
      state.pendingToolMessageIds[callId] !== binding.toolMessageId)
  ) {
    return { allowed: false, reason: 'tool_not_pending' };
  }
  return { allowed: true };
}
