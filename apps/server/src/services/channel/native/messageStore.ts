import { randomUUID } from 'node:crypto';

import type { CreateMessageParams, MessagePluginItem, UIChatMessage } from '@lobechat/types';

import { ChannelError } from '@/database/models/channel';
import type { ChannelRuntimeModel } from '@/database/models/channelRuntime';
import type { MessageModel } from '@/database/models/message';
import type { LobeChatDatabase } from '@/database/type';
import type {
  RuntimeMessageStore,
  RuntimeStoredMessage,
} from '@/server/modules/AgentRuntime/context';
import { merge } from '@/utils/merge';

import { hydrateChannelMessageAttachments } from './attachments';

/** Row shape the `messages`-table lookups on the port are typed with. */
type StoredRow = NonNullable<Awaited<ReturnType<MessageModel['findById']>>>;

/** The runtime's idempotency key is stored alongside the UI fields. */
type PrivateRow = UIChatMessage & { clientId?: string };

/**
 * {@link RuntimeMessageStore} over one Channel member's private transcript.
 *
 * Every row `execAgent` writes for a Channel native run lands in
 * `channel_runtime_messages` through this adapter; nothing touches `messages`
 * or `topics`. Rows are keyed by the runtime's own idempotency keys (the
 * assistant `clientId`, or `parentId:tool_call_id` for tool rows) so a retried
 * step reuses its placeholder the same way the `messages` table's unique
 * `clientId` does.
 */
export class ChannelRuntimeMessageStore implements RuntimeMessageStore {
  constructor(
    private readonly store: ChannelRuntimeModel,
    private readonly ownerId: string,
    private readonly db: LobeChatDatabase,
  ) {}

  private async all(): Promise<PrivateRow[]> {
    return this.store.messages(true);
  }

  /**
   * The port's lookups are typed as `messages` rows. The runtime only reads
   * `id` / `role` / `parentId` / `topicId` / `content` / `metadata` and the
   * `RuntimeMessageRef` columns, all of which the UI shape carries.
   */
  private static asRow(message: UIChatMessage | undefined) {
    return message as unknown as StoredRow | undefined;
  }

  private static toRef(message: UIChatMessage): RuntimeStoredMessage {
    return {
      agentId: message.agentId,
      content: message.content,
      groupId: message.groupId,
      id: message.id,
      metadata: message.metadata,
      model: message.model,
      parentId: message.parentId,
      provider: message.provider,
      role: message.role,
      threadId: message.threadId,
      topicId: message.topicId,
    };
  }

  private static stableKey(params: CreateMessageParams) {
    if (params.clientId) return params.clientId;
    if (params.role === 'tool' && params.tool_call_id && params.parentId)
      return `${params.parentId}:${params.tool_call_id}`;
    return undefined;
  }

  private patch(id: string, apply: (message: UIChatMessage) => UIChatMessage) {
    return this.store.updateMessage(id, apply).then(
      () => true,
      (error) => {
        if (error instanceof ChannelError && error.code === 'NOT_FOUND') return false;
        throw error;
      },
    );
  }

  create = async (params: CreateMessageParams, id = `chn_private_${randomUUID()}`) => {
    const now = Date.now();
    const row = await this.store.createMessage(
      {
        ...params,
        content: params.content || '',
        createdAt: now,
        id,
        meta: {},
        updatedAt: now,
      } as UIChatMessage,
      ChannelRuntimeMessageStore.stableKey(params),
    );
    return ChannelRuntimeMessageStore.toRef(row);
  };

  deleteMessage = (id: string) => this.store.deleteMessage(id);

  findByClientId = async (clientId: string) =>
    ChannelRuntimeMessageStore.asRow(
      (await this.all()).find((message) => message.clientId === clientId),
    );

  findById = async (id: string) =>
    ChannelRuntimeMessageStore.asRow((await this.all()).find((message) => message.id === id));

  findLatestAssistantByOperationId = async ({ operationId }: { operationId: string }) =>
    ChannelRuntimeMessageStore.asRow(
      (await this.all()).findLast(
        (message) => message.role === 'assistant' && message.metadata?.operationId === operationId,
      ),
    );

  findMessagePlugin = async (messageId: string): Promise<MessagePluginItem | undefined> => {
    const message = (await this.all()).find((item) => item.id === messageId);
    if (!message || message.role !== 'tool') return undefined;
    return {
      apiName: message.plugin?.apiName,
      arguments: message.plugin?.arguments,
      clientId: message.clientId,
      error: message.pluginError,
      id: message.id,
      identifier: message.plugin?.identifier,
      intervention: message.pluginIntervention,
      state: message.pluginState,
      toolCallId: message.tool_call_id,
      type: message.plugin?.type ?? 'default',
      userId: this.ownerId,
    };
  };

  findToolMessageIdByToolCallId = async (toolCallId: string, parentMessageId?: string) =>
    (await this.all()).find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === toolCallId &&
        (!parentMessageId || message.parentId === parentMessageId),
    )?.id;

  query = () => this.store.messages();

  resolveAttachments = async (messages: UIChatMessage[]) => {
    const originals = new Map((await this.store.messages(true)).map((row) => [row.id, row]));
    // Start from canonical content so repeated builds cannot accumulate warnings or
    // reuse signed URLs from the initial discovery snapshot. Never write this view back.
    return hydrateChannelMessageAttachments(
      this.db,
      this.ownerId,
      messages.map((message) => {
        const original = originals.get(message.id);
        return original?.files?.length
          ? { ...message, content: original.content, files: original.files }
          : message;
      }),
    );
  };

  update: RuntimeMessageStore['update'] = async (id, { metadata, ...params }) => {
    const success = await this.patch(id, (message) => ({
      ...message,
      ...(params as Partial<UIChatMessage>),
      ...(metadata && { metadata: merge(message.metadata || {}, metadata) }),
    }));
    return { success };
  };

  /** Column-replacing like the model's; throws for a missing row the same way. */
  updateMessagePlugin = (id: string, value: Partial<MessagePluginItem>) =>
    this.store.updateMessage(id, (message) => ({
      ...message,
      ...(value.error !== undefined && { pluginError: value.error }),
      ...(value.intervention !== undefined && { pluginIntervention: value.intervention }),
      ...(value.state !== undefined && { pluginState: value.state }),
      ...((value.apiName || value.arguments || value.identifier || value.type) && {
        plugin: {
          ...message.plugin,
          ...(value.apiName && { apiName: value.apiName }),
          ...(value.arguments && { arguments: value.arguments }),
          ...(value.identifier && { identifier: value.identifier }),
          ...(value.type && { type: value.type }),
        } as UIChatMessage['plugin'],
      }),
    }));

  updatePluginState = async (id: string, state: Record<string, any>) => {
    await this.patch(id, (message) => ({
      ...message,
      pluginState: { ...message.pluginState, ...state },
    }));
  };

  updateToolMessage: RuntimeMessageStore['updateToolMessage'] = async (
    id,
    { content, heterogeneousToolState, metadata, pluginError, pluginState },
  ) => {
    // Mirrors `MessageModel.updateToolMessage`: snapshot writes must advance
    // the per-operation sequence, and then replace the runtime state wholesale.
    let applied = true;
    const success = await this.patch(id, (message) => {
      const existing = message.metadata || {};
      if (heterogeneousToolState) {
        const currentSeq =
          existing.heterogeneousToolStateOperationId === heterogeneousToolState.operationId &&
          typeof existing.heterogeneousToolStateSeq === 'number'
            ? existing.heterogeneousToolStateSeq
            : 0;
        if (heterogeneousToolState.snapshotSeq <= currentSeq) {
          applied = false;
          return message;
        }
      }
      return {
        ...message,
        ...(content !== undefined && { content }),
        ...((metadata !== undefined || heterogeneousToolState) && {
          metadata: merge(merge(existing, metadata || {}), {
            ...(heterogeneousToolState && {
              heterogeneousToolStateOperationId: heterogeneousToolState.operationId,
              heterogeneousToolStateSeq: heterogeneousToolState.snapshotSeq,
            }),
          }),
        }),
        ...(pluginError !== undefined && { pluginError }),
        ...(pluginState !== undefined && {
          pluginState: heterogeneousToolState
            ? pluginState
            : { ...message.pluginState, ...pluginState },
        }),
      };
    });
    return { applied: success && applied, success };
  };
}
