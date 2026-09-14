import { randomUUID } from 'node:crypto';

import type {
  AgentRuntimeContext,
  AgentRuntimeHost,
  AgentState,
  ContextBuilder,
  ToolTransport,
} from '@lobechat/agent-runtime';
import {
  AgentRuntime,
  createAgentRuntimeExecutors,
  GeneralChatAgent,
  normalizeAgentState,
} from '@lobechat/agent-runtime';
import { CHANNEL_INSTRUCTIONS, channelContext } from '@lobechat/heterogeneous-agents/channel/input';
import type { ChannelMemberConfig, ChatToolPayload, UIChatMessage } from '@lobechat/types';

import { ChannelRuntimeModel } from '@/database/models/channelRuntime';
import type { LobeChatDatabase } from '@/database/type';

import { ChannelBudget, type ChannelBudgetSnapshot } from '../budget';
import { createChannelCompressionTransport } from './compression';
import { createChannelContextBuilder } from './context';
import { createChannelLLMTransport } from './llm';
import { createChannelMessageTransport } from './messages';

export interface ChannelNativeCapabilities {
  compressionEnabled?: boolean;
  context?: ContextBuilder;
  contextWindowTokens?: number;
  enabledToolIds?: string[];
  modelParameters?: Record<string, unknown>;
  modelRuntimeConfig?: AgentState['modelRuntimeConfig'];
  runtimeContext?: Pick<AgentState, 'binding' | 'plan' | 'principal' | 'world'>;
  systemRole?: string;
  toolExecutorMap?: AgentState['toolExecutorMap'];
  /** Resolved, authorized native tool manifests and execution adapter. */
  toolManifestMap: AgentState['toolManifestMap'];
  tools: NonNullable<AgentState['tools']>;
  toolSourceMap?: AgentState['toolSourceMap'];
  toolTransport?: ToolTransport;
  userInterventionConfig?: AgentState['userInterventionConfig'];
}

/** Only this boundary is safe to resume: no approved tool has started yet. */
export function isChannelApprovalCheckpoint(
  checkpoint: Record<string, unknown> | undefined,
  runId: string,
) {
  const state = checkpoint?.state as AgentState | undefined;
  const budget = checkpoint?.budget as ChannelBudgetSnapshot | undefined;
  return (
    checkpoint?.runId === runId &&
    checkpoint.phase === 'awaiting_approval' &&
    state?.status === 'waiting_for_human' &&
    !!state.pendingToolsCalling?.length &&
    !!budget &&
    [budget.activeMs, budget.modelCalls, budget.toolCalls].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  );
}

/** Executes the package's GeneralChatAgent and executors with Channel-only persistence. */
export async function runChannelNative(input: {
  capabilities: ChannelNativeCapabilities;
  budget?: ChannelBudget;
  config: ChannelMemberConfig;
  db: LobeChatDatabase;
  fence: number;
  onApproval?: (tool: ChatToolPayload) => Promise<void>;
  onAccepted: (sessionId: string, turnId: string) => Promise<void>;
  onActivity?: (state: 'running' | 'typing') => Promise<void>;
  ownerId: string;
  runId: string;
  signal: AbortSignal;
}) {
  if (input.capabilities.tools.length && !input.capabilities.toolTransport)
    throw new Error('Native tools are configured but their Channel transport is unavailable');
  const store = new ChannelRuntimeModel(input.db, input.ownerId, input.runId, input.fence);
  const { run, checkpoint } = await store.load();
  const resuming = isChannelApprovalCheckpoint(checkpoint, run.id);
  if (checkpoint?.runId === run.id && !resuming)
    throw new Error('Native execution checkpoint exists; inspect before resuming');
  const budget =
    input.budget ||
    new ChannelBudget(resuming ? (checkpoint!.budget as ChannelBudgetSnapshot) : undefined);
  budget.resume();
  const timeoutAbort = new AbortController();
  const signal = AbortSignal.any([input.signal, timeoutAbort.signal]);
  const timeout = setInterval(() => {
    try {
      budget.assertTime();
    } catch (error) {
      timeoutAbort.abort(error);
    }
  }, 250);
  try {
    const transport = createChannelMessageTransport(store);
    // Public input is copied into this private session once, with explicit author/source labels.
    for (const message of run.manifest.messages) {
      await store.createMessage(
        {
          id: `chn_input_${randomUUID()}`,
          role: 'user',
          content: JSON.stringify({
            kind: 'channel_history',
            author: message.author,
            messageId: message.id,
            sequence: message.sequence,
            threadId: message.threadId,
            content: message.content,
          }),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        `public:${message.id}`,
      );
    }
    const activeRequest = run.manifest.messages.find(
      (message) => message.id === run.manifest.requestMessageId,
    );
    await store.createMessage(
      {
        id: `chn_input_${randomUUID()}`,
        role: 'user',
        content: JSON.stringify({
          kind: activeRequest?.author.type === 'human' ? 'channel_request' : 'channel_update',
          ...channelContext(run.manifest),
          instruction:
            'Use the attributed history above together with earlier session context. The active request may already have been delivered. Do not replay completed actions or claim another member’s work as yours.',
        }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      `delivery:${run.id}`,
    );
    const history = await store.messages();
    let state = AgentRuntime.createInitialState({
      ...input.capabilities.runtimeContext,
      operationId: run.id,
      origin: {
        agentId: input.config.agentId ?? run.memberId,
        topicId: run.sessionId,
        userId: input.ownerId,
      },
      messages: history,
      systemRole: input.capabilities.systemRole ?? input.config.systemRole,
      toolManifestMap: input.capabilities.toolManifestMap,
      tools: input.capabilities.tools,
      toolSourceMap: input.capabilities.toolSourceMap,
      toolExecutorMap: input.capabilities.toolExecutorMap,
      userInterventionConfig: input.capabilities.userInterventionConfig,
      operationToolSet: {
        enabledToolIds:
          input.capabilities.enabledToolIds ?? Object.keys(input.capabilities.toolManifestMap),
        manifestMap: input.capabilities.toolManifestMap,
        sourceMap: input.capabilities.toolSourceMap ?? {},
        executorMap: input.capabilities.toolExecutorMap ?? {},
        tools: input.capabilities.tools,
      },
      modelRuntimeConfig: input.capabilities.modelRuntimeConfig ?? {
        model: input.config.model,
        provider: input.config.provider,
      },
    });
    if (resuming) state = normalizeAgentState(checkpoint!.state as AgentState);
    const contextBuilder =
      input.capabilities.context ||
      createChannelContextBuilder(
        input.capabilities.contextWindowTokens,
        input.capabilities.modelParameters,
      );
    const channelRole = `${CHANNEL_INSTRUCTIONS}\n\n${JSON.stringify(channelContext(run.manifest))}`;
    const host: AgentRuntimeHost = {
      operation: {
        operationId: run.id,
        agentId: run.memberId,
        topicId: run.sessionId,
        userId: input.ownerId,
        stepIndex: 0,
        abortSignal: signal,
      },
      transports: {
        messages: transport,
        context: {
          // Inject at every build, after checkpoint recovery and before token accounting.
          // Do not persist the introduction into state, where it would accumulate on resume.
          build: (args) =>
            contextBuilder.build({
              ...args,
              state: {
                ...args.state,
                systemRole: [args.state.systemRole, channelRole].filter(Boolean).join('\n\n'),
              },
            }),
        },
        compression: createChannelCompressionTransport(store),
        llm: createChannelLLMTransport(input.db, input.ownerId, budget, signal, input.onActivity),
        stream: { publishChunk: async () => {}, publishEvent: async () => {} },
        operationStore: {
          clearRunningMark: async () => {},
          loadState: async () => (signal.aborted ? { ...state, status: 'interrupted' } : state),
        },
        tools: input.capabilities.toolTransport && {
          ...input.capabilities.toolTransport,
          run: async (...args) => {
            budget.toolCall();
            return input.capabilities.toolTransport!.run(...args);
          },
        },
      },
    };
    const agent = new GeneralChatAgent({
      operationId: run.id,
      userId: input.ownerId,
      modelRuntimeConfig: state.modelRuntimeConfig,
      compressionConfig: {
        enabled: input.capabilities.compressionEnabled ?? true,
        maxWindowToken: input.capabilities.contextWindowTokens,
      },
      tools: state.tools,
    });
    const runtime = new AgentRuntime(agent, { executors: createAgentRuntimeExecutors(host) });
    if (!resuming)
      await store.save({ runId: run.id, state, budget: budget.checkpoint(), phase: 'accepted' });
    await input.onAccepted(run.sessionId, run.id);
    let context: AgentRuntimeContext | undefined;
    while (!['done', 'error', 'interrupted', 'waiting_for_async_tool'].includes(state.status)) {
      signal.throwIfAborted();
      if (state.status === 'waiting_for_human') {
        const tools = [...(state.pendingToolsCalling || [])];
        if (!tools.length || !input.onApproval)
          throw new Error('Channel approval handler unavailable');
        budget.pauseForApproval();
        await store.save({
          runId: run.id,
          state,
          budget: budget.checkpoint(),
          phase: 'awaiting_approval',
        });
        for (const tool of tools) await input.onApproval(tool);
        budget.resume();
        signal.throwIfAborted();
        for (const tool of tools) {
          const messageId = state.pendingToolMessageIds?.[tool.id];
          if (!messageId) throw new Error('Durable approval tool message is missing');
          await transport.updateToolIntervention(messageId, { status: 'approved' });
        }
        state = { ...state, pendingToolsCalling: [], status: 'running' };
        const approvalContext: AgentRuntimeContext = {
          operationId: run.id,
          phase: 'human_approved_tool',
          payload: {
            approvedToolCalls: tools,
            parentMessageId: state.pendingApprovalBatch?.assistantMessageId,
            toolMessageIds: state.pendingToolMessageIds,
          },
          session: {
            sessionId: run.id,
            messageCount: state.messages.length,
            status: state.status,
            stepCount: state.stepCount,
          },
        };
        await store.save({
          runId: run.id,
          state,
          context: approvalContext,
          budget: budget.checkpoint(),
          phase: 'step_started',
        });
        const approved = await runtime.step(state, approvalContext);
        state = approved.newState;
        context = approved.nextContext;
        await store.save({
          runId: run.id,
          state,
          context: context || null,
          budget: budget.checkpoint(),
          phase: 'step_completed',
        });
        continue;
      }
      budget.assertTime();
      host.operation.stepIndex = state.stepCount;
      await store.save({
        runId: run.id,
        state,
        context: context || null,
        budget: budget.checkpoint(),
        phase: 'step_started',
      });
      const result = await runtime.step(state, context);
      state = result.newState;
      context = result.nextContext;
      await store.save({
        runId: run.id,
        state,
        context: context || null,
        budget: budget.checkpoint(),
        phase: 'step_completed',
      });
    }
    if (state.status === 'error')
      throw state.error instanceof Error
        ? state.error
        : new Error(String(state.error?.message || 'Native runtime failed'));
    if (state.status !== 'done')
      throw new Error(
        state.status === 'waiting_for_async_tool'
          ? 'This Native tool requires an asynchronous host that is unavailable in Channel'
          : 'Channel Native execution interrupted',
      );
    const final = state.messages.findLast(
      (message: UIChatMessage & { tool_calls?: unknown[] }) =>
        message.role === 'assistant' && !message.tool_calls?.length,
    );
    if (!final?.content) throw new Error('Native completed without a publishable final');
    return { state, budget: budget.checkpoint(), content: final.content as string, waiting: false };
  } finally {
    clearInterval(timeout);
  }
}
