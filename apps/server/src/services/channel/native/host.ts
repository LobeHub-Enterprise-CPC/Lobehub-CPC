import type { AgentState } from '@lobechat/agent-runtime';
import { CHANNEL_INSTRUCTIONS, channelContext } from '@lobechat/heterogeneous-agents/channel/input';
import type { ChannelMemberConfig } from '@lobechat/types';
import { CHANNEL_LIMITS } from '@lobechat/types';

import { AgentOperationModel } from '@/database/models/agentOperation';
import { ChannelModel } from '@/database/models/channel';
import { ChannelNativeModel } from '@/database/models/channelNative';
import type { channelRuns } from '@/database/privateSchemas/channel';
import type { LobeChatDatabase } from '@/database/type';
import { AiAgentService } from '@/server/services/aiAgent';
import { QueueService } from '@/server/services/queue';

import { loadChannelNativeCapabilities } from './capabilities';

interface NativeInput {
  db: LobeChatDatabase;
  ownerId: string;
  run: typeof channelRuns.$inferSelect;
}

export function channelNativeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error)
    return [error.message, error.cause && channelNativeError(error.cause)]
      .filter(Boolean)
      .join(': ');
  if (!error) return 'Native Agent execution failed without an error receipt';
  return JSON.stringify(error);
}

const serviceFor = ({ db, ownerId }: NativeInput) =>
  new AiAgentService(db, ownerId, { withholdGatewayToken: true });
const storeFor = ({ db, ownerId, run }: NativeInput) =>
  new ChannelNativeModel(db, ownerId, { runId: run.id, fence: run.executionFence });

/** Prepare once; the durable ready record is written by the standard runtime before queue dispatch. */
export async function startChannelNative(input: NativeInput) {
  const store = storeFor(input);
  const prepared = await store.prepare();
  if (!prepared.fresh) return;
  const { run, operation } = prepared;
  const config = run.executionConfig as ChannelMemberConfig;
  const capabilities = await loadChannelNativeCapabilities(input.db, input.ownerId, config);
  const manifest = { ...run.manifest };
  if (prepared.reconstruct && manifest.source === 'incremental') {
    // Upgrade an old private transcript from the public source of truth. Its
    // accepted-message watermark must not make the first real topic lose history.
    const detail = await new ChannelModel(input.db, input.ownerId).detail(run.channelId);
    const thread = detail.threads.find((item) => item.id === manifest.threadId);
    manifest.messages = detail.messages
      .filter(
        (message) =>
          message.sequence <= manifest.cutoffSequence &&
          (thread
            ? message.threadId === thread.id ||
              (!message.threadId && message.sequence <= thread.rootSequence)
            : !message.threadId),
      )
      .map((message) => ({
        id: message.id,
        content: message.content,
        sequence: message.sequence,
        threadId: message.threadId,
        author: message.authorMemberId
          ? {
              id: message.authorMemberId,
              name:
                detail.members.find((m) => m.id === message.authorMemberId)?.name ??
                message.authorMemberId,
              type: 'member' as const,
            }
          : { id: input.ownerId, name: 'User', type: 'human' as const },
      }));
  }
  const result = await serviceFor(input)
    .execAgent({
      agentId: config.agentId!,
      operationId: operation.operationId,
      appContext: { topicId: operation.topicId },
      autoStart: true,
      channelRun: { runId: run.id, fence: run.executionFence },
      topicConfigPolicy: 'agent',
      instructions: `${CHANNEL_INSTRUCTIONS}\n\n${JSON.stringify(channelContext(manifest))}`,
      prompt: JSON.stringify({
        kind: 'channel_delivery',
        ...channelContext(manifest),
        messages: manifest.messages,
      }),
      ...capabilities,
    })
    .catch(async (error: unknown) => {
      const { operations } = await store.load();
      if (operations.some((op) => op.ready)) return undefined;
      throw error;
    });
  if (!result) return;
  if (!result.success || !result.autoStarted) {
    // A ready operation may already be queued despite response loss. Reconcile
    // that same id; never submit the user's input to execAgent a second time.
    const { operations } = await store.load();
    if (!operations.some((op) => op.ready))
      throw new Error(result.error || 'Native Agent operation did not start');
  }
}

/** Restart-safe control plane. Parked async work remains with the standard runtime. */
export async function reconcileChannelNative(input: NativeInput, stopped: boolean) {
  const store = storeFor(input);
  const { run, operations, effects, checkpoint } = await store.load();
  const model = new ChannelModel(input.db, input.ownerId);
  const service = serviceFor(input);
  const roots = operations
    .filter((op) => !op.parentOperationId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const operation =
    roots.find((op) => op.operationId === checkpoint?.currentOperationId) ?? roots.at(-1);
  if (!operation) {
    await model.executionUnknown(
      run.channelId,
      run.id,
      run.fence,
      'Legacy Native execution has no standard operation receipt; inspect before retrying',
    );
    return;
  }
  const activeMs =
    Number(checkpoint?.activeMs ?? 0) +
    (checkpoint?.activeSince ? Date.now() - Number(checkpoint.activeSince) : 0);
  const budgetError =
    activeMs >= CHANNEL_LIMITS.executionMs
      ? 'Channel execution time limit reached'
      : checkpoint?.approvalSince &&
          Date.now() - Number(checkpoint.approvalSince) >= CHANNEL_LIMITS.approvalMs
        ? 'Channel approval expired'
        : undefined;
  if (budgetError && !stopped) {
    await model.fail(run.channelId, run.id, run.fence, budgetError);
    stopped = true;
  }
  if (stopped) {
    for (const op of operations.filter((op) => op.ready))
      await service.interruptTask({ operationId: op.operationId, topicId: op.topicId });
    // The sentinel prevents queued work from launching. Effects are settled by
    // the real transport promise, not by interruptTask's acknowledgement.
    if (effects.every((effect) => effect.settled))
      await model.releaseWriter(run.channelId, run.id, run.fence);
    return;
  }
  if (!operation.ready) {
    await model.fail(
      run.channelId,
      run.id,
      run.fence,
      'Native Agent preparation ended before the durable start checkpoint',
    );
    await model.releaseWriter(run.channelId, run.id, run.fence);
    return;
  }
  await model.accepted(run.channelId, run.id, run.fence, operation.topicId, operation.operationId);
  if (!operation.submitted) {
    if (!(await service.loadInterventionContinuationState(operation.operationId))) {
      await model.executionUnknown(
        run.channelId,
        run.id,
        run.fence,
        'Native runtime state is missing; the prepared input will not be replayed',
      );
      return;
    }
    await new QueueService().scheduleMessage({
      operationId: operation.operationId,
      stepIndex: operation.stepIndex,
      context: operation.initialContext ?? undefined,
      deduplicationId: `channel-start:${operation.operationId}`,
      endpoint: `${process.env.AGENT_RUNTIME_BASE_URL || process.env.APP_URL}/api/agent/run`,
    });
    await store.submitted(operation.operationId);
  }
  const durable = await new AgentOperationModel(input.db, input.ownerId).findById(
    operation.operationId,
  );
  const receipt = checkpoint?.receipt as
    | (Partial<AgentState> & {
        operationId: string;
        content?: string;
        model?: string;
        provider?: string;
      })
    | undefined;
  const state = await service.loadInterventionContinuationState(operation.operationId);
  const intent = checkpoint?.approvalIntent as
    | (Pick<AgentState, 'pendingToolsCalling' | 'pendingToolMessageIds'> & { operationId: string })
    | undefined;
  const approvalState =
    intent?.operationId === operation.operationId
      ? intent
      : state?.status === 'waiting_for_human'
        ? state
        : undefined;
  if (approvalState?.pendingToolsCalling?.length) {
    const approvals = await Promise.all(
      approvalState.pendingToolsCalling.map((tool) =>
        model.requestApproval(
          run.channelId,
          run.id,
          run.fence,
          `${run.id}:${operation.operationId}:${tool.id}`,
          { tool },
          new Date(Number(checkpoint?.approvalSince ?? Date.now()) + CHANNEL_LIMITS.approvalMs),
        ),
      ),
    );
    if (approvals.some((a) => a.decision && a.decision !== 'approved')) {
      await model.stop(run.channelId, { runId: run.id });
      return;
    }
    if (approvals.every((a) => a.decision === 'approved')) {
      const decisions = approvalState.pendingToolsCalling.map((tool) => {
        const parentMessageId = approvalState.pendingToolMessageIds?.[tool.id];
        if (!parentMessageId) throw new Error('Native approval tool message is missing');
        return { decision: 'approved' as const, parentMessageId, toolCallId: tool.id };
      });
      const capabilities = await loadChannelNativeCapabilities(
        input.db,
        input.ownerId,
        run.executionConfig!,
      );
      await store.prepareApproval(operation.operationId, approvalState);
      const result = await service.execAgent({
        agentId: run.executionConfig!.agentId!,
        appContext: { topicId: operation.topicId },
        approvalResolutionRequestId: `channel:${operation.operationId}`,
        approvalSourceOperationId: operation.operationId,
        replacesOperationId: operation.operationId,
        channelRun: { runId: run.id, fence: run.executionFence },
        parentMessageId: decisions[0].parentMessageId,
        prompt: '',
        resume: true,
        resumeApprovals: decisions,
        instructions: `${CHANNEL_INSTRUCTIONS}\n\n${JSON.stringify(channelContext(run.manifest))}`,
        ...capabilities,
      });
      if (!result.success || !result.autoStarted)
        throw new Error(result.error || 'Native approval continuation was not scheduled');
      await service.retirePendingApprovalOperation(operation.operationId);
      await model.resumeAfterApproval(run.channelId, run.id, run.fence);
    }
    return;
  }
  if (durable?.status === 'waiting_for_async_tool' || state?.status === 'waiting_for_async_tool')
    return;
  if (!durable || !['done', 'error', 'interrupted', 'abandoned'].includes(durable.status)) return;
  if (effects.some((effect) => !effect.settled)) {
    await model.executionUnknown(
      run.channelId,
      run.id,
      run.fence,
      'An external call has no termination receipt; inspect before retrying',
    );
    return;
  }
  // A child may outlive its parent's visible response. Do not release the writer while it can still act.
  for (const child of operations.filter((op) => op.parentOperationId)) {
    const status = await new AgentOperationModel(input.db, input.ownerId).findById(
      child.operationId,
    );
    if (!status || !['done', 'error', 'interrupted'].includes(status.status)) return;
  }
  if (durable.status !== 'done') {
    await model.fail(
      run.channelId,
      run.id,
      run.fence,
      channelNativeError(state?.error ?? receipt?.error ?? durable.error),
    );
  } else {
    if (receipt?.operationId !== operation.operationId || !receipt.content) {
      await model.fail(
        run.channelId,
        run.id,
        run.fence,
        'Native Agent completed without a publishable reply receipt',
      );
    } else {
      await model.recordExecution(run.channelId, run.id, run.fence, {
        runtime: 'native',
        model: receipt.model,
        provider: receipt.provider,
        activeMs: Number(checkpoint?.activeMs),
        modelCalls: Number(checkpoint?.modelCalls),
        toolCalls: Number(checkpoint?.toolCalls),
      });
      await model.saveDraft(run.channelId, run.id, run.fence, receipt.content);
      await model.publish(run.channelId, run.id, run.fence);
    }
  }
  await model.releaseWriter(run.channelId, run.id, run.fence);
}
