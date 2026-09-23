import { type AgentState, type RuntimeMessageRef } from '@lobechat/agent-runtime';
import {
  type AgentShareVisitorContext,
  type CreateMessageParams,
  type ExecSubAgentParams,
  type ExecSubAgentResult,
  type ExecVirtualSubAgentParams,
  type MessagePluginItem,
  type UIChatMessage,
  type UpdateMessageParams,
} from '@lobechat/types';

import { type MessageModel } from '@/database/models/message';
import { type LobeChatDatabase } from '@/database/type';
import type { HookDispatcher } from '@/server/services/agentRuntime/hooks/HookDispatcher';
import type {
  ExecGroupMemberParams,
  ExecGroupMemberResult,
} from '@/server/services/agentRuntime/types';
import { type ToolExecutionService } from '@/server/services/toolExecution';

import { type IStreamEventManager } from './types';

/** The subset of a stored message row the runtime and completion paths read back. */
export type RuntimeStoredMessage = RuntimeMessageRef & {
  content?: string | null;
  metadata?: Record<string, any> | null;
};

/**
 * Message persistence port the agent runtime writes through.
 *
 * `MessageModel` (the `messages` table) satisfies it and is the default. A host
 * with its own transcript store (Channel native runs keep every row in
 * `channel_runtime_messages`) supplies an adapter so `execAgent` runs end to
 * end without touching `messages` / `topics`. Parameter types are derived from
 * `MessageModel` so the model stays the single definition of each call shape.
 */
export interface RuntimeMessageStore {
  create: (params: CreateMessageParams, id?: string) => Promise<RuntimeStoredMessage>;
  deleteMessage: (id: string, options?: { includeShareVisitor?: boolean }) => Promise<unknown>;
  // The three lookups mirror the model's own (loosely typed relational-query)
  // return shapes; callers only read `id` / `content` / `metadata` off them.
  findByClientId: (clientId: string) => ReturnType<MessageModel['findByClientId']>;
  findById: (id: string) => ReturnType<MessageModel['findById']>;
  findLatestAssistantByOperationId: (params: {
    operationId: string;
    topicId: string;
  }) => ReturnType<MessageModel['findLatestAssistantByOperationId']>;
  findMessagePlugin: (messageId: string) => Promise<MessagePluginItem | undefined>;
  findToolMessageIdByToolCallId: (
    toolCallId: string,
    parentMessageId?: string,
  ) => Promise<string | null | undefined>;
  query: (
    params?: Parameters<MessageModel['query']>[0],
    options?: Parameters<MessageModel['query']>[1],
  ) => Promise<UIChatMessage[]>;
  /** Host-owned transcripts refresh attachment views per call, without persisting signed URLs. */
  resolveAttachments?: (messages: UIChatMessage[]) => Promise<UIChatMessage[]>;
  update: (id: string, params: Partial<UpdateMessageParams>) => Promise<{ success: boolean }>;
  updateMessagePlugin: (id: string, value: Partial<MessagePluginItem>) => Promise<unknown>;
  updatePluginState: (id: string, state: Record<string, any>) => Promise<void>;
  updateToolMessage: (
    id: string,
    params: Parameters<MessageModel['updateToolMessage']>[1],
  ) => Promise<{ applied: boolean; success: boolean }>;
}

/** Context engineering is reusable by hosts with their own message persistence. */
export type RuntimeContextBuilderContext = Pick<
  RuntimeExecutorContext,
  | 'agentShareVisitor'
  | 'modelRuntimeConfig'
  | 'operationId'
  | 'serverDB'
  | 'stepIndex'
  | 'stream'
  | 'topicId'
  | 'tracingContextEngine'
  | 'userId'
  | 'workspaceId'
> & { messageModel?: RuntimeMessageStore };

export interface RuntimeExecutorContext {
  /**
   * Cancels tool work that is still in flight for this step. Driven by the
   * persisted interruption flag (the step runs in its own invocation, so there
   * is no in-process controller to share with whoever requested the stop).
   */
  abortSignal?: AbortSignal;
  /**
   * Shared-agent visitor marker, read back from
   * `state.principal.actor.shareVisitor`. Present ONLY for a share-visitor run;
   * its presence alone is the signal every per-step consumer keys off. Forwarded
   * into `ToolExecutionContext.agentShareVisitor` so
   * `BuiltinToolsExecutor.execute` can re-check the visitor's grants right
   * before dispatch — see `isShareBlockedDataToolCall` in `shareGate.ts`.
   */
  agentShareVisitor?: AgentShareVisitorContext;
  /**
   * Allows call_llm to publish visible_output_end immediately after a no-tool
   * LLM stream_end. Only the default GeneralChatAgent treats no-tool llm_result
   * as a final answer; injected multi-step agents such as GraphAgent can emit
   * tools: [] for an intermediate graph node and continue to another node.
   */
  allowEarlyFinalAnswerVisibleOutputEnd?: boolean;
  botContext?: unknown;
  /**
   * Callback to fork a group member ("call agent member") under a
   * `lobe-group-management` tool call. Injected by AiAgentService; powers the
   * per-tool `agentMember` runner (in-group + isolated members, K=N barrier).
   */
  execGroupMember?: (params: ExecGroupMemberParams) => Promise<ExecGroupMemberResult>;
  /**
   * Callback to run a legacy agent invocation server-side.
   * Injected by AiAgentService so exec_sub_agent / exec_sub_agents executors
   * can dispatch callAgent-triggered runs without a circular import.
   */
  execSubAgent?: (params: ExecSubAgentParams) => Promise<ExecSubAgentResult>;
  /**
   * Callback to fork a `lobe-agent.callSubAgent` virtual child run. Unlike
   * execSubAgent, this path installs the async completion bridge and marks the
   * child operation as a sub-agent.
   */
  execVirtualSubAgent?: (params: ExecVirtualSubAgentParams) => Promise<ExecSubAgentResult>;
  hookDispatcher?: HookDispatcher;
  loadAgentState?: (operationId: string) => Promise<AgentState | null>;
  messageModel: RuntimeMessageStore;
  modelRuntimeConfig?: AgentState['modelRuntimeConfig'];
  operationId: string;
  serverDB: LobeChatDatabase;
  stepIndex: number;
  stream?: boolean;
  streamManager: IStreamEventManager;
  toolExecutionService: ToolExecutionService;
  topicId?: string;
  /**
   * Trace-pipeline sink for context engine input/output. Wired by
   * AgentRuntimeService so the trace recorder can pick CE data up
   * out-of-band, keeping the heavy CE payload (agentDocuments, systemRole, …)
   * out of the `events` array and therefore out of the Redis state pipeline.
   *
   * Context: agent-runtime state blob was hitting Upstash Redis 10MB limit
   * because contextEngine.input (agentDocuments full inline) accounted for
   * ~83% of each step. Routing CE through this callback keeps the heavy
   * payload in trace only, reducing per-step Redis state from ~3.4MB to ~6KB.
   */
  tracingContextEngine?: (input: unknown, output: unknown, metadata?: unknown) => void;
  userId?: string;
  /**
   * Workspace scoping for ownership filters on models/services constructed
   * inside the agent runtime. Threaded down from the originating request
   * (chat/task router) and forwarded to tool executions via
   * `ToolExecutionContext.workspaceId`.
   */
  workspaceId?: string;
}
