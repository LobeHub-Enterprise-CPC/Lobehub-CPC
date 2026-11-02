import { AgentRuntimeErrorType, ChatErrorType } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import {
  executeDirectMention,
  toDirectMentionMessageError,
  toDirectMentionThreadTitle,
} from './directMentionExecutor';

describe('toDirectMentionMessageError', () => {
  it('maps an offline execution device to the actionable device-gateway error', () => {
    const error = toDirectMentionMessageError(
      new Error('{"error":"DEVICE_OFFLINE","success":false}'),
    );

    expect(error).toEqual({ type: ChatErrorType.DeviceGatewayNotConfigured });
  });

  it('keeps unexpected failures on the generic agent-runtime error path', () => {
    expect(toDirectMentionMessageError(new Error('gateway exploded'))).toEqual({
      body: { message: 'gateway exploded' },
      message: 'gateway exploded',
      type: AgentRuntimeErrorType.AgentRuntimeError,
    });
  });
});

describe('toDirectMentionThreadTitle', () => {
  it('shows mentions as @name instead of their markup', () => {
    expect(
      toDirectMentionThreadTitle('<mention name="小雯" id="agt_6Hzr1skp1IRb" />你能干什么'),
    ).toBe('@小雯 你能干什么');
  });

  it('keeps the first 50 characters of the readable text', () => {
    expect(toDirectMentionThreadTitle(`<mention name="A" id="agt_a" /> ${'x'.repeat(80)}`)).toBe(
      `@A ${'x'.repeat(47)}`,
    );
  });
});

describe('executeDirectMention', () => {
  it('refreshes the mentioned agent transcripts so an open thread panel shows the reply', async () => {
    const { ClientSubAgentTransport } =
      await import('@/store/chat/agents/transports/ClientSubAgentTransport');
    vi.spyOn(ClientSubAgentTransport.prototype, 'execSubAgent').mockResolvedValue({
      result: 'reply',
      success: true,
      threadId: 'thd_1',
    } as any);
    const store = {
      associateMessageWithOperation: vi.fn(),
      completeOperation: vi.fn(),
      optimisticUpdateMessageContent: vi.fn().mockResolvedValue(undefined),
      refreshMessages: vi.fn().mockResolvedValue(undefined),
      refreshThreads: vi.fn().mockResolvedValue(undefined),
      startOperation: vi.fn(() => ({ operationId: 'op_client' })),
    };

    await executeDirectMention(
      {
        context: { agentId: 'agt_lobe', topicId: 'tpc_1' },
        instruction: '<mention name="小雯" id="agt_xw" />你能干什么',
        parentOperationId: 'op_send',
        runtimeType: 'gateway',
        sourceMessageId: 'msg_src',
        targetAgentId: 'agt_xw',
      },
      () => store as any,
    );

    expect(store.refreshMessages).toHaveBeenCalledWith({ agentId: 'agt_xw', topicId: 'tpc_1' });
  });

  it('lets the mentioned agent read the conversation it is answering in', async () => {
    const { ClientSubAgentTransport } =
      await import('@/store/chat/agents/transports/ClientSubAgentTransport');
    const execSubAgent = vi
      .spyOn(ClientSubAgentTransport.prototype, 'execSubAgent')
      .mockResolvedValue({ result: 'reply', success: true, threadId: 'thd_1' } as any);
    const store = {
      associateMessageWithOperation: vi.fn(),
      completeOperation: vi.fn(),
      optimisticUpdateMessageContent: vi.fn().mockResolvedValue(undefined),
      refreshMessages: vi.fn().mockResolvedValue(undefined),
      refreshThreads: vi.fn().mockResolvedValue(undefined),
      startOperation: vi.fn(() => ({ operationId: 'op_client' })),
    };

    await executeDirectMention(
      {
        context: { agentId: 'agt_lobe', topicId: 'tpc_1' },
        instruction: '<mention name="小雯" id="agt_xw" />你能读到前面聊了什么吗',
        parentOperationId: 'op_send',
        runtimeType: 'gateway',
        sourceMessageId: 'msg_src',
        targetAgentId: 'agt_xw',
      },
      () => store as any,
    );

    expect(execSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ inheritTopicHistory: true, parentMessageId: 'msg_src' }),
    );
  });

  it('shows the running thread at once and streams the child while it runs', async () => {
    const { ClientSubAgentTransport } =
      await import('@/store/chat/agents/transports/ClientSubAgentTransport');
    const stopWatching = vi.fn();
    const store = {
      associateMessageWithOperation: vi.fn(),
      completeOperation: vi.fn(),
      internal_dispatchMessage: vi.fn(),
      optimisticUpdateMessageContent: vi.fn().mockResolvedValue(undefined),
      refreshMessages: vi.fn().mockResolvedValue(undefined),
      refreshThreads: vi.fn().mockResolvedValue(undefined),
      startOperation: vi.fn(() => ({ operationId: 'op_client' })),
      watchSubAgentRun: vi.fn(() => stopWatching),
    };
    vi.spyOn(ClientSubAgentTransport.prototype, 'execSubAgent').mockImplementation(async function (
      this: any,
    ) {
      this.options.onDispatched({
        assistantMessageId: 'msg_child',
        operationId: 'op_child',
        success: true,
        threadId: 'thd_1',
        token: 'child-ticket',
      });
      expect(stopWatching).not.toHaveBeenCalled();
      // The panel needs the thread (and its agent) while the child still runs.
      expect(store.refreshThreads).toHaveBeenCalled();
      return { result: 'reply', success: true, threadId: 'thd_1' } as any;
    });

    await executeDirectMention(
      {
        context: { agentId: 'agt_lobe', topicId: 'tpc_1' },
        instruction: '<mention name="小雯" id="agt_xw" />你能干什么',
        parentOperationId: 'op_send',
        runtimeType: 'gateway',
        sourceMessageId: 'msg_src',
        targetAgentId: 'agt_xw',
      },
      () => store as any,
    );

    expect(store.internal_dispatchMessage).toHaveBeenCalledWith(
      {
        id: 'msg_src',
        type: 'updateMessage',
        value: {
          taskDetail: expect.objectContaining({ status: 'processing', threadId: 'thd_1' }),
        },
      },
      { operationId: 'op_client' },
    );
    expect(store.watchSubAgentRun).toHaveBeenCalledWith({
      assistantMessageId: 'msg_child',
      context: { agentId: 'agt_xw', scope: 'thread', threadId: 'thd_1', topicId: 'tpc_1' },
      operationId: 'op_child',
      token: 'child-ticket',
    });
    expect(stopWatching).toHaveBeenCalled();
  });
});
