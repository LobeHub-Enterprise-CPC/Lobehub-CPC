import { randomUUID } from 'node:crypto';

import type { AgentState } from '@lobechat/agent-runtime';
import { CHANNEL_INSTRUCTIONS, channelContext } from '@lobechat/heterogeneous-agents/channel/input';
import type { UIChatMessage } from '@lobechat/types';

import { ChannelRuntimeModel } from '@/database/models/channelRuntime';
import type { channelRuns } from '@/database/privateSchemas/channel';
import type { LobeChatDatabase } from '@/database/type';
import { InMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';
import { AiAgentService } from '@/server/services/aiAgent';

import { buildChannelArtifactManifest } from '../artifactTool';
import { ChannelBudget, type ChannelBudgetSnapshot } from '../budget';
import { ChannelRuntimeMessageStore } from './messageStore';

export interface ChannelNativeResult {
  budget: ChannelBudgetSnapshot;
  content: string;
  operationId: string;
  state: AgentState;
}

/** Statuses `executeSync` parks on; nothing in a Channel run can resume them. */
const PARKED = new Set<AgentState['status']>(['waiting_for_human', 'waiting_for_async_tool']);

/**
 * Runs one Channel member turn through `execAgent`, the same pipeline as chat.
 *
 * What differs from a chat turn is only what Channel owns: the transcript
 * lives in `channel_runtime_messages` (no `messages` / `topics` rows), tools
 * run headless (no approval), Agent Signal is suppressed, and the run is
 * driven to completion in this process by `executeSync` under the Channel
 * budget instead of by the queue.
 */
export async function runChannelNative(input: {
  agentId: string;
  /** Runs whose published snapshots this member may read through `channel-artifact`. */
  artifactRunIds: string[];
  budget?: ChannelBudget;
  db: LobeChatDatabase;
  onAccepted: (sessionId: string, operationId: string) => Promise<void>;
  ownerId: string;
  run: Pick<typeof channelRuns.$inferSelect, 'channelId' | 'fence' | 'id'>;
  signal: AbortSignal;
}): Promise<ChannelNativeResult> {
  const store = new ChannelRuntimeModel(input.db, input.ownerId, input.run.id, input.run.fence);
  const { run, checkpoint } = await store.load();
  // A previous worker already created an operation for this Run. Its outcome
  // is unknown to us; never submit the same input a second time.
  if (checkpoint?.runId === run.id)
    throw new Error('Native execution checkpoint exists; inspect before resuming');
  const budget = input.budget ?? new ChannelBudget();
  budget.assertTime();

  // Public input is copied into this private session once, with explicit author/source labels.
  const stamp = () => ({ createdAt: Date.now(), updatedAt: Date.now() });
  for (const message of run.manifest.messages) {
    await store.createMessage(
      {
        id: `chn_input_${randomUUID()}`,
        role: 'user',
        files: message.fileIds,
        content: JSON.stringify({
          kind: 'channel_history',
          author: message.author,
          messageId: message.id,
          sequence: message.sequence,
          threadId: message.threadId,
          content: message.content,
        }),
        ...stamp(),
      },
      `public:${message.id}`,
    );
  }
  const activeRequest = run.manifest.messages.find(
    (message) => message.id === run.manifest.requestMessageId,
  );
  const delivery = await store.createMessage(
    {
      id: `chn_input_${randomUUID()}`,
      role: 'user',
      content: JSON.stringify({
        kind: activeRequest?.author.type === 'human' ? 'channel_request' : 'channel_update',
        ...channelContext(run.manifest),
        instruction:
          'Use the attributed history above together with earlier session context. The active request may already have been delivered. Do not replay completed actions or claim another member’s work as yours.',
      }),
      ...stamp(),
    },
    `delivery:${run.id}`,
  );

  const messageStore = new ChannelRuntimeMessageStore(store, input.ownerId, input.db);
  const service = new AiAgentService(input.db, input.ownerId, {
    runtimeOptions: {
      messageStore,
      // executeSync drives every step in this process; nothing may be queued.
      queueService: null,
      streamEventManager: new InMemoryStreamEventManager(),
    },
    withholdGatewayToken: true,
  });
  const artifactManifest = buildChannelArtifactManifest(input.artifactRunIds);
  const started = await service.execAgent({
    agentId: input.agentId,
    autoStart: false,
    channelContext: {
      artifactRunIds: input.artifactRunIds,
      channelId: run.channelId,
      fence: run.fence,
      runId: run.id,
    },
    // Compression requires a topic-backed transport. Until it supports the
    // private store, avoid scheduling a skipped compression before every call.
    chatConfigOverride: { enableContextCompression: false },
    instructions: `${CHANNEL_INSTRUCTIONS}\n\n${JSON.stringify(channelContext(run.manifest))}`,
    prompt: '',
    serverToolManifests: artifactManifest && [artifactManifest],
    signal: input.signal,
    stream: false,
    title: `Channel ${run.channelId} · ${run.id}`,
    transcript: {
      deliveryMessageId: delivery.id,
      load: async () => messageStore.resolveAttachments(await messageStore.query()),
    },
    trigger: 'channel',
    userInterventionConfig: { approvalMode: 'headless' },
  });
  if (!started.success) throw new Error(started.error || 'Native operation did not start');
  const operationId = started.operationId;
  await store.save({ runId: run.id, operationId, phase: 'accepted' });
  await input.onAccepted(run.sessionId, operationId);

  let stopReason: Error | undefined;
  const stop = (reason: Error) => {
    stopReason ??= reason;
    return service.interruptOperation(operationId).catch(() => false);
  };
  const onAbort = () => void stop(new Error('Native execution was interrupted'));
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  const timeout = setInterval(() => {
    try {
      budget.assertTime();
    } catch (error) {
      void stop(error as Error);
    }
  }, 250);
  let state: AgentState;
  try {
    state = await service.executeSync(operationId, {
      onStepComplete: async (_step, current) => {
        if (['done', 'error', 'interrupted'].includes(current.status)) return;
        try {
          budget.observe(current.usage);
        } catch (error) {
          await stop(error as Error);
        }
      },
    });
  } finally {
    clearInterval(timeout);
    input.signal.removeEventListener('abort', onAbort);
  }
  // Counters come from the runtime, whatever way the loop ended.
  const usage = state.usage;
  const snapshot = {
    ...budget.checkpoint(),
    modelCalls: usage.llm.apiCalls,
    toolCalls: usage.tools.totalCalls,
  };

  if (stopReason) throw stopReason;
  if (state.status === 'error')
    throw state.error instanceof Error
      ? state.error
      : new Error(String(state.error?.message || 'Native runtime failed'));
  if (PARKED.has(state.status))
    throw new Error(
      state.status === 'waiting_for_human'
        ? 'Channel Native runs are headless; this tool requires human approval'
        : 'This Native tool requires an asynchronous host that is unavailable in Channel',
    );
  if (state.status !== 'done') throw new Error('Channel Native execution interrupted');
  const final = (await store.messages()).findLast(
    (message: UIChatMessage) =>
      message.role === 'assistant' &&
      message.metadata?.operationId === operationId &&
      !message.tools?.length,
  );
  if (!final?.content) throw new Error('Native completed without a publishable final');
  return { budget: snapshot, content: final.content, operationId, state };
}
