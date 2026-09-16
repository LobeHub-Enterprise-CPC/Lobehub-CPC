// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerToolTransport } from './ServerToolTransport';

const { mockArchiveRuntimeToolResult } = vi.hoisted(() => ({
  mockArchiveRuntimeToolResult: vi.fn(async (result) => result),
}));

vi.mock('../executorHelpers', () => ({
  archiveRuntimeToolResult: mockArchiveRuntimeToolResult,
  buildServerAgentMemberRunner: vi.fn(),
  buildServerVirtualSubAgentRunner: vi.fn(),
  GEN_AI_FUNCTION_TOOL_TYPE: 'function',
  isOperationInterrupted: vi.fn(() => false),
  log: vi.fn(),
  registerWorkFromIntent: vi.fn(),
  TOOL_MAX_RETRIES: 0,
  TOOL_PRICING: {},
}));

vi.mock('@/database/models/agent', () => ({
  AgentModel: vi.fn(function () {
    return { getAgentVisibility: vi.fn().mockResolvedValue(null) };
  }),
}));

describe('ServerToolTransport.run', () => {
  const executeTool = vi.fn();
  const payload = {
    apiName: 'search',
    arguments: '{}',
    id: 'tool-call-1',
    identifier: 'web-search',
    type: 'default',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    executeTool.mockResolvedValue({ content: 'result', success: true });
  });

  const run = async (channel?: Record<string, unknown>) => {
    const transport = new ServerToolTransport({
      operationId: 'op-1',
      serverDB: {},
      stepIndex: 0,
      streamManager: {},
      toolExecutionService: { executeTool },
      userId: 'user-1',
    } as any);

    await transport.run(
      payload as any,
      {
        callIndex: 0,
        effectiveManifestMap: {},
        mode: 'batch',
        parentMessageId: 'assistant-1',
        parsedArgs: {},
        state: channel ? { principal: { actor: { channel } } } : {},
        toolMessageId: 'tool-message-1',
        toolName: 'search',
      } as any,
    );
  };

  it('propagates the Channel actor context to the tool execution service', async () => {
    const channelContext = { channelId: 'channel-1', fence: 3, runId: 'run-1' };

    await run(channelContext);

    expect(executeTool).toHaveBeenCalledWith(payload, expect.objectContaining({ channelContext }));
  });

  it('passes undefined channel context for an ordinary run', async () => {
    await run();

    expect(executeTool).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ channelContext: undefined }),
    );
  });

  it.each([true, false])(
    'passes a refreshed private media scope only for Channel runs (channel=%s)',
    async (channel) => {
      const raw = [{ id: 'delivery', role: 'user', content: 'request' }];
      const query = vi.fn().mockResolvedValue(raw);
      const resolveAttachments = vi.fn();
      const transport = new ServerToolTransport({
        messageModel: { query, resolveAttachments },
        operationId: 'op',
        serverDB: {},
        stepIndex: 0,
        streamManager: {},
        toolExecutionService: { executeTool },
        userId: 'owner',
      } as any);
      for (const url of ['/first-signed', '/renewed-signed']) {
        const sources = [...raw, { id: 'private-source', imageList: [{ id: 'image', url }] }];
        resolveAttachments.mockResolvedValue(sources);
        await transport.run(
          { ...payload, identifier: 'lobe-agent', apiName: 'analyzeMedia' } as any,
          {
            effectiveManifestMap: {},
            mode: 'batch',
            parsedArgs: {},
            state: {
              origin: { sourceMessageId: 'delivery' },
              principal: {
                actor: channel ? { channel: { channelId: 'channel', runId: 'run', fence: 1 } } : {},
              },
            },
            toolName: 'analyzeMedia',
          } as any,
        );
        expect(executeTool).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({
            messageId: 'delivery',
            mediaSourceMessages: channel ? sources : undefined,
          }),
        );
      }
      if (channel) {
        expect(query).toHaveBeenCalledTimes(2);
        expect(resolveAttachments).toHaveBeenLastCalledWith(raw);
      } else {
        expect(query).not.toHaveBeenCalled();
        expect(resolveAttachments).not.toHaveBeenCalled();
      }
    },
  );
});
