// @vitest-environment node
import type * as ModelRuntimeModule from '@lobechat/model-runtime';
import type { UIChatMessage, UserInterventionConfig } from '@lobechat/types';
import { beforeEach, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { runChannelNative } from './host';

const mocks = vi.hoisted(() => ({ chat: vi.fn(), save: vi.fn() }));
let messages: UIChatMessage[];
vi.mock('@/database/models/channelRuntime', () => ({
  ChannelRuntimeModel: class {
    load = async () => ({
      run: {
        id: 'run',
        sessionId: 'session',
        memberId: 'member',
        manifest: { messages: [], requestMessageId: 'request', threadId: null },
      },
    });
    messages = async () => [...messages];
    createMessage = async (message: UIChatMessage) => {
      messages.push(message);
      return message;
    };
    updateMessage = async (id: string, patch: (message: UIChatMessage) => UIChatMessage) => {
      messages = messages.map((message) => (message.id === id ? patch(message) : message));
    };
    save = mocks.save;
  },
}));
vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn().mockResolvedValue({ chat: mocks.chat }),
}));
vi.mock('@lobechat/model-runtime', async (original) => ({
  ...(await original<typeof ModelRuntimeModule>()),
  consumeStreamUntilDone: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  messages = [];
  mocks.chat
    .mockImplementationOnce(async (_payload, { callback }) => {
      await callback.onToolsCalling({
        toolsCalling: [
          {
            id: 'call',
            type: 'function',
            function: { name: 'my-mcp____lookup____mcp', arguments: '{}' },
          },
        ],
      });
      return new Response();
    })
    .mockImplementationOnce(async (_payload, { callback }) => {
      await callback.onText('Lookup complete');
      return new Response();
    });
});

it.each<{
  approvalMode: UserInterventionConfig['approvalMode'];
  allowList: string[];
  approvals: number;
  policy: 'required' | 'always';
}>([
  { approvalMode: 'auto-run', allowList: [], approvals: 0, policy: 'required' },
  { approvalMode: 'manual', allowList: ['my-mcp/lookup'], approvals: 1, policy: 'required' },
  { approvalMode: 'allow-list', allowList: ['my-mcp/lookup'], approvals: 0, policy: 'required' },
  { approvalMode: 'allow-list', allowList: ['my-mcp/other'], approvals: 1, policy: 'required' },
  { approvalMode: 'auto-run', allowList: [], approvals: 1, policy: 'always' },
])(
  'runs Channel tools with $approvalMode / $policy / $allowList',
  async ({ approvalMode, allowList, approvals, policy }) => {
    const execute = vi.fn().mockResolvedValue({
      attempts: 1,
      result: { success: true, content: 'Found' },
    });
    const onApproval = vi.fn(async () => {
      expect(execute).not.toHaveBeenCalled();
    });
    const result = await runChannelNative({
      capabilities: {
        compressionEnabled: false,
        userInterventionConfig: { approvalMode, allowList },
        tools: [
          { type: 'function', function: { name: 'my-mcp____lookup____mcp', parameters: {} } },
        ],
        toolManifestMap: {
          'my-mcp': {
            identifier: 'my-mcp',
            type: 'mcp',
            humanIntervention: policy,
            api: [
              {
                name: 'lookup',
                description: 'Lookup',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
        },
        toolTransport: { run: execute },
      },
      config: { runtime: 'native', agentId: 'agent', model: 'model', provider: 'openai' },
      db: {} as LobeChatDatabase,
      fence: 1,
      ownerId: 'owner',
      runId: 'run',
      signal: new AbortController().signal,
      onAccepted: vi.fn(),
      onApproval,
    });
    expect(result.content).toBe('Lookup complete');
    expect(onApproval).toHaveBeenCalledTimes(approvals);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'my-mcp', apiName: 'lookup' }),
      expect.anything(),
    );
    expect(result.state.userInterventionConfig).toEqual({ approvalMode, allowList });
  },
);
