import { createHash } from 'node:crypto';

import type { AgentRuntimeContext, AgentState } from '@lobechat/agent-runtime';
import { CHANNEL_LIMITS } from '@lobechat/types';
import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  channelNativeEffects,
  channelNativeOperations,
  channelRuns,
  channelRuntimeStates,
  channels,
  channelSessions,
} from '../privateSchemas/channel';
import { messages } from '../schemas/message';
import { topics } from '../schemas/topic';
import type { LobeChatDatabase, Transaction } from '../type';

export interface ChannelNativeBinding {
  fence: number;
  runId: string;
}

/** Personal Channels deliberately use the owner's personal model scope, never a caller workspace. */
export class ChannelNativeModel {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly ownerId: string,
    private readonly binding: ChannelNativeBinding,
  ) {}

  private async guard(tx: Transaction, allowStopped = false) {
    const [entry] = await tx
      .select({ run: channelRuns })
      .from(channelRuns)
      .innerJoin(channels, eq(channels.id, channelRuns.channelId))
      .where(
        and(
          eq(channels.ownerId, this.ownerId),
          eq(channelRuns.id, this.binding.runId),
          eq(channelRuns.executionFence, this.binding.fence),
        ),
      )
      .for('update', { of: channelRuns });
    if (!entry || (!allowStopped && (entry.run.publicationRevoked || entry.run.writerReleased)))
      throw new Error('Channel native execution authority was revoked');
    return entry.run;
  }

  async prepare() {
    return this.db.transaction(async (tx) => {
      const run = await this.guard(tx);
      const [session] = await tx
        .select()
        .from(channelSessions)
        .where(eq(channelSessions.id, run.sessionId));
      const topicId = `tpc_channel_${createHash('sha256').update(`${session.id}:${session.generation}`).digest('hex').slice(0, 24)}`;
      const operationId = `op_channel_${run.id}`;
      const [existing] = await tx
        .select()
        .from(channelNativeOperations)
        .where(eq(channelNativeOperations.operationId, operationId));
      if (existing) return { operation: existing, run, fresh: false, reconstruct: false };
      await tx
        .insert(topics)
        .values({
          id: topicId,
          agentId: run.executionConfig!.agentId,
          userId: this.ownerId,
          title: `Channel · ${run.manifest.self?.name ?? run.memberId}`,
          trigger: 'channel',
        })
        .onConflictDoNothing();
      const [topic] = await tx.select().from(topics).where(eq(topics.id, topicId));
      if (
        topic.userId !== this.ownerId ||
        topic.workspaceId ||
        topic.agentId !== run.executionConfig!.agentId
      )
        throw new Error('Channel topic ownership conflict');
      const [operation] = await tx
        .insert(channelNativeOperations)
        .values({ operationId, runId: run.id, topicId })
        .returning();
      await tx
        .insert(channelRuntimeStates)
        .values({
          sessionId: session.id,
          runId: run.id,
          state: {
            runId: run.id,
            activeMs: 0,
            activeSince: Date.now(),
            modelCalls: 0,
            toolCalls: 0,
          },
        })
        .onConflictDoUpdate({
          target: channelRuntimeStates.sessionId,
          set: {
            runId: run.id,
            state: {
              runId: run.id,
              activeMs: 0,
              activeSince: Date.now(),
              modelCalls: 0,
              toolCalls: 0,
            },
          },
        });
      return { operation, run, fresh: true, reconstruct: session.nativeSessionId !== topicId };
    });
  }

  async ready(input: {
    operationId: string;
    topicId: string;
    assistantMessageId?: string;
    parentOperationId?: string;
    initialContext?: AgentRuntimeContext;
    stepIndex: number;
  }) {
    await this.db.transaction(async (tx) => {
      const run = await this.guard(tx);
      await tx
        .insert(channelNativeOperations)
        .values({ ...input, runId: this.binding.runId, ready: true })
        .onConflictDoUpdate({
          target: channelNativeOperations.operationId,
          set: { ...input, ready: true },
        });
      if (!input.parentOperationId) {
        const [record] = await tx
          .select()
          .from(channelRuntimeStates)
          .where(eq(channelRuntimeStates.sessionId, run.sessionId));
        await tx
          .update(channelRuntimeStates)
          .set({
            state: {
              ...record.state,
              currentOperationId: input.operationId,
              approvalIntent: null,
              approvalSince: null,
              activeSince: Date.now(),
            },
          })
          .where(eq(channelRuntimeStates.sessionId, run.sessionId));
      }
    });
  }

  async prepareApproval(
    operationId: string,
    state: Pick<AgentState, 'pendingToolsCalling' | 'pendingToolMessageIds'>,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.guard(tx);
      const [record] = await tx
        .select()
        .from(channelRuntimeStates)
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
      if (record?.runId !== run.id || record.state.currentOperationId !== operationId)
        throw new Error('Channel approval source changed');
      await tx
        .update(channelRuntimeStates)
        .set({
          state: {
            ...record.state,
            approvalIntent: {
              operationId,
              pendingToolsCalling: state.pendingToolsCalling,
              pendingToolMessageIds: state.pendingToolMessageIds,
            },
          },
        })
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
    });
  }

  async submitted(operationId: string) {
    await this.db
      .update(channelNativeOperations)
      .set({ submitted: true })
      .where(
        and(
          eq(channelNativeOperations.runId, this.binding.runId),
          eq(channelNativeOperations.operationId, operationId),
        ),
      );
  }

  async load() {
    return this.db.transaction(async (tx) => {
      const run = await this.guard(tx, true);
      const [checkpoint] = await tx
        .select()
        .from(channelRuntimeStates)
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
      const operations = await tx
        .select()
        .from(channelNativeOperations)
        .where(eq(channelNativeOperations.runId, run.id));
      const effects = await tx
        .select()
        .from(channelNativeEffects)
        .where(eq(channelNativeEffects.runId, run.id));
      return {
        run,
        operations,
        effects,
        checkpoint: checkpoint?.runId === run.id ? checkpoint.state : undefined,
      };
    });
  }

  /** Called at the actual external-call boundary, including every model retry. */
  async beginEffect(operationId: string, id: string, kind: 'model' | 'tool') {
    await this.db.transaction(async (tx) => {
      const run = await this.guard(tx);
      const [record] = await tx
        .select()
        .from(channelRuntimeStates)
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
      if (record?.runId !== run.id) throw new Error('Channel budget checkpoint missing');
      const state = record.state;
      const activeMs =
        Number(state.activeMs ?? 0) +
        (state.activeSince ? Date.now() - Number(state.activeSince) : 0);
      if (activeMs >= CHANNEL_LIMITS.executionMs)
        throw new Error('Channel execution time limit reached');
      const count = kind === 'model' ? 'modelCalls' : 'toolCalls';
      if (Number(state[count] ?? 0) >= CHANNEL_LIMITS[count])
        throw new Error(`Channel ${kind} call limit reached`);
      const [effect] = await tx
        .insert(channelNativeEffects)
        .values({ id, operationId, runId: run.id, kind })
        .onConflictDoNothing()
        .returning();
      if (!effect) throw new Error(`Channel external call already started; refusing replay: ${id}`);
      await tx
        .update(channelRuntimeStates)
        .set({
          state: {
            ...state,
            activeMs,
            activeSince: Date.now(),
            [count]: Number(state[count] ?? 0) + 1,
          },
        })
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
    });
  }

  async settleEffect(id: string) {
    await this.db
      .update(channelNativeEffects)
      .set({ settled: true })
      .where(
        and(eq(channelNativeEffects.runId, this.binding.runId), eq(channelNativeEffects.id, id)),
      );
  }

  /** Durable completion/park receipt; no in-memory hook is needed to publish or resume. */
  async observe(operationId: string, state: AgentState) {
    await this.db.transaction(async (tx) => {
      const run = await this.guard(tx, true);
      const [operation] = await tx
        .select()
        .from(channelNativeOperations)
        .where(eq(channelNativeOperations.operationId, operationId));
      if (!operation || operation.parentOperationId) return;
      const [record] = await tx
        .select()
        .from(channelRuntimeStates)
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
      if (record?.runId !== run.id) throw new Error('Channel run checkpoint missing');
      const old = record.state;
      if (old.currentOperationId !== operationId) return;
      const paused = state.status === 'waiting_for_human';
      // The runtime's finalizer persists this identity across compression. Verify
      // its durable provenance instead of depending on retained in-memory history.
      const answerId = state.metadata?.workAssistantMessageId;
      const [answer] =
        typeof answerId === 'string'
          ? await tx
              .select({ content: messages.content, tools: messages.tools })
              .from(messages)
              .where(
                and(
                  eq(messages.id, answerId),
                  eq(messages.userId, this.ownerId),
                  eq(messages.topicId, operation.topicId),
                  isNull(messages.workspaceId),
                  eq(messages.role, 'assistant'),
                  sql`${messages.metadata}->>'operationId' = ${operationId}`,
                ),
              )
          : [];
      const content =
        answer && !(Array.isArray(answer.tools) && answer.tools.length)
          ? answer.content
          : undefined;
      const receipt = {
        operationId,
        status: state.status,
        stepCount: state.stepCount,
        content,
        error: state.error,
        pendingToolsCalling: state.pendingToolsCalling,
        pendingToolMessageIds: state.pendingToolMessageIds,
        pendingApprovalBatch: state.pendingApprovalBatch,
        model: state.modelRuntimeConfig?.model,
        provider: state.modelRuntimeConfig?.provider,
      };
      await tx
        .update(channelRuntimeStates)
        .set({
          state: {
            ...old,
            receipt,
            activeMs:
              Number(old.activeMs ?? 0) +
              (old.activeSince ? Date.now() - Number(old.activeSince) : 0),
            activeSince:
              paused || ['done', 'error', 'interrupted'].includes(state.status) ? null : Date.now(),
            approvalSince: paused || old.approvalIntent ? (old.approvalSince ?? Date.now()) : null,
          },
        })
        .where(eq(channelRuntimeStates.sessionId, run.sessionId));
    });
  }
}
