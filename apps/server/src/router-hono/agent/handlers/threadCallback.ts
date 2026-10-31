import type { AgentState } from '@lobechat/agent-runtime';
import { ThreadStatus } from '@lobechat/types';
import debug from 'debug';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentOperationModel } from '@/database/models/agentOperation';
import { MessageModel } from '@/database/models/message';
import { ThreadModel } from '@/database/models/thread';
import { agentOperations } from '@/database/schemas/agentOperations';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime';
import { AiAgentService } from '@/server/services/aiAgent';
import {
  applyThreadCompletion,
  applyThreadProgress,
  calculateTotalTokens,
} from '@/server/services/aiAgent/hooks/threadRunHooks';

const log = debug('lobe-server:agent:thread-callback');
const nonEmptyString = z.string().trim().min(1);
const callbackSchema = z.object({
  hookType: z.enum(['afterStep', 'onComplete']),
  logScope: z.string().optional(),
  operationId: nonEmptyString,
  reason: z.string().optional(),
  runToken: nonEmptyString,
  sourceMessageId: nonEmptyString.optional(),
  startedAt: nonEmptyString,
  stepIndex: z.number().int().nonnegative().optional(),
  steps: z.number().int().nonnegative().optional(),
  threadId: nonEmptyString,
  toolCalls: z.number().nonnegative().optional(),
  usageBaseline: z
    .object({
      totalCost: z.number().optional(),
      totalMessages: z.number().optional(),
      totalTokens: z.number().optional(),
      totalToolCalls: z.number().optional(),
    })
    .optional(),
});

/** QStash-authenticated thread lifecycle writes for cross-process execution. */
export async function threadCallback(c: Context): Promise<Response> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = callbackSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid thread callback body' }, 400);
  const body = parsed.data;
  const { hookType, operationId, runToken, startedAt, threadId, usageBaseline } = body;

  try {
    const coordinator = new AgentRuntimeCoordinator();
    const metadata = await coordinator.getOperationMetadata(operationId);
    const serverDB = await getServerDB();
    let owner: { streamOwnerUserId?: string; userId: string; workspaceId?: string } | undefined;
    if (metadata?.userId) {
      owner = {
        streamOwnerUserId: metadata.streamOwnerUserId,
        userId: metadata.userId,
        workspaceId: metadata.workspaceId,
      };
    } else {
      const [row] = await serverDB
        .select({ userId: agentOperations.userId, workspaceId: agentOperations.workspaceId })
        .from(agentOperations)
        .where(eq(agentOperations.id, operationId))
        .limit(1);
      if (row) owner = { userId: row.userId, workspaceId: row.workspaceId ?? undefined };
    }
    if (!owner) return c.json({ error: 'Invalid operation or unauthorized' }, 401);

    const threadModel = new ThreadModel(serverDB, owner.userId, owner.workspaceId);
    const thread = await threadModel.findById(threadId);
    if (!thread) {
      log('Skipping missing or inaccessible thread %s for operation %s', threadId, operationId);
      return c.json({ skipped: true });
    }
    if (
      ![ThreadStatus.Processing, ThreadStatus.InReview].includes(thread.status as ThreadStatus) ||
      thread.metadata?.runToken !== runToken
    ) {
      return c.json({ skipped: true });
    }

    const state = await coordinator.loadAgentState(operationId);
    if (hookType === 'afterStep' && !state) return c.json({ skipped: true });
    const aiAgentService = new AiAgentService(serverDB, owner.userId, {
      includeShareVisitor: !!owner.streamOwnerUserId,
      workspaceId: owner.workspaceId,
    });

    if (hookType === 'afterStep') {
      // The event index orders writes. The coordinator may already hold a later
      // state; its messages are never serialized, so restore them from the DB.
      const progressStep = body.stepIndex ?? body.steps ?? state!.stepCount;
      if (
        thread.metadata.progressOperationId === operationId &&
        thread.metadata.progressStep !== undefined &&
        progressStep <= thread.metadata.progressStep
      ) {
        return c.json({ skipped: true });
      }
      const { messages } = await aiAgentService.loadRunMessagesFromDB(state!);
      const updated = await applyThreadProgress(threadModel, {
        operationId,
        runToken,
        progressStep,
        startedAt,
        threadId,
        totalMessages: messages.length,
        totalTokens: calculateTotalTokens(state!.usage),
        totalToolCalls: body.toolCalls,
        usageBaseline,
      });
      return c.json({ success: true, updated });
    }

    // The terminal row is persisted before this hook is accepted. Redis expiry
    // must not freeze an incomplete final usage/error summary onto the thread.
    const durableOperation = !state
      ? await new AgentOperationModel(serverDB, owner.userId, owner.workspaceId).findById(
          operationId,
        )
      : undefined;
    if (!state && !durableOperation)
      return c.json({ error: 'Final operation data unavailable' }, 503);
    const summary = state
      ? {
          cost: state.cost?.total,
          tokens: calculateTotalTokens(state.usage),
          toolCalls: state.usage?.tools?.totalCalls,
          error: state.error,
        }
      : {
          cost: durableOperation!.totalCost,
          tokens: durableOperation!.totalTokens,
          toolCalls: durableOperation!.toolCalls,
          error: durableOperation!.error,
        };

    // The durable thread supplies the query scope when the Redis state expired.
    const messageState =
      state ??
      ({
        operationId,
        origin: {
          agentId: thread.agentId,
          groupId: thread.groupId,
          threadId,
          topicId: thread.topicId,
        },
      } as AgentState);
    const { lastAssistantContent, messages } =
      await aiAgentService.loadRunMessagesFromDB(messageState);
    // Commit summary and terminal status together: a summary failure must not
    // leave a terminal row that would cause the delivery retry to be skipped.
    const updated = await serverDB.transaction(async (tx) =>
      applyThreadCompletion(
        new ThreadModel(tx, owner.userId, owner.workspaceId),
        new MessageModel(tx, owner.userId, owner.workspaceId, undefined, {
          includeShareVisitor: Boolean(owner.streamOwnerUserId),
        }),
        {
          lastAssistantContent,
          operationId,
          reason: body.reason,
          runToken,
          sourceMessageId: body.sourceMessageId,
          startedAt,
          summary: {
            error: summary.error,
            totalCost: summary.cost,
            totalTokens: summary.tokens,
            totalToolCalls: summary.toolCalls,
          },
          threadId,
          totalMessages: messages.length,
          usageBaseline,
        },
      ),
    );
    return c.json({ success: true, updated });
  } catch (error) {
    // Log identifiers only: DB/provider errors may contain message bodies.
    log(
      'Thread callback failed: hook=%s operation=%s thread=%s errorType=%s',
      hookType,
      operationId,
      threadId,
      error instanceof Error ? error.name : typeof error,
    );
    return c.json({ error: 'Thread callback failed' }, 500);
  }
}
