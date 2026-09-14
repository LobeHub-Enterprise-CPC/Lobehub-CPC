import { randomUUID } from 'node:crypto';

import type { MessageTransport } from '@lobechat/agent-runtime';
import type { CreateMessageParams, UIChatMessage } from '@lobechat/types';

import type { ChannelRuntimeModel } from '@/database/models/channelRuntime';

export const createChannelMessageTransport = (store: ChannelRuntimeModel): MessageTransport => {
  const create = async (params: CreateMessageParams, key?: string) => {
    const data = {
      ...params,
      content: params.content || '',
      id: `chn_private_${randomUUID()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      meta: {},
    } as UIChatMessage;
    return store.createMessage(data, key);
  };
  return {
    createAssistantMessage: (params, options) => create(params, options?.idempotencyKey),
    createToolMessage: (params) =>
      create(params, params.tool_call_id && `${params.parentId}:${params.tool_call_id}`),
    deleteMessage: (id) => store.deleteMessage(id),
    findById: async (id) => (await store.messages(true)).find((m) => m.id === id),
    findToolMessageIdByToolCallId: async (callId, parentId) =>
      (await store.messages()).find((m) => m.tool_call_id === callId && m.parentId === parentId)
        ?.id,
    query: () => store.messages(),
    update: (id, params) =>
      store.updateMessage(id, (message) => ({ ...message, ...params }) as UIChatMessage),
    updatePluginState: (id, state) =>
      store.updateMessage(id, (message) => ({
        ...message,
        pluginState: { ...message.pluginState, ...state },
      })),
    updateToolIntervention: (id, intervention) =>
      store.updateMessage(
        id,
        (message) =>
          ({
            ...message,
            pluginIntervention: { ...message.pluginIntervention, ...intervention },
          }) as UIChatMessage,
      ),
    updateToolMessage: (id, params) =>
      store.updateMessage(id, (message) => ({ ...message, ...params }) as UIChatMessage),
  };
};
