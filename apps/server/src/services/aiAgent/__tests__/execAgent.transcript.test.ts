// @vitest-environment node
import { GeneralChatAgent } from '@lobechat/agent-runtime';
import type { UIChatMessage } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRuntimeModel } from '@/database/models/channelRuntime';
import { ServerLLMTransport } from '@/server/modules/AgentRuntime/adapters/ServerLLMTransport';
import { InMemoryAgentStateManager } from '@/server/modules/AgentRuntime/InMemoryAgentStateManager';
import { InMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';
import { buildChannelArtifactManifest } from '@/server/services/channel/artifactTool';
import { ChannelRuntimeMessageStore } from '@/server/services/channel/native/messageStore';
import type * as WorkRegistration from '@/server/services/workRegistration';

import { AiAgentService } from '../index';
import type { InternalExecAgentParams } from '../types';

const mocks = vi.hoisted(() => ({
  messageCreate: vi.fn(),
  messageQuery: vi.fn(),
  recordCompletion: vi.fn(async () => true),
  recordStart: vi.fn(async () => {}),
  resolveFiles: vi.fn(),
  topicCreate: vi.fn(),
  topicUpdate: vi.fn(),
}));

vi.mock('@/server/services/file/resolveAttachments', () => ({
  resolveAttachmentsByFileIds: mocks.resolveFiles,
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    create = mocks.messageCreate;
    query = mocks.messageQuery;
  },
}));
vi.mock('@/database/models/topic', () => ({
  TopicModel: class {
    create = mocks.topicCreate;
    updateMetadata = mocks.topicUpdate;
    tryReserveTaskCallback = vi.fn(async () => true);
    releaseTaskCallbackReservation = vi.fn(async () => {});
  },
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    recordStart = mocks.recordStart;
    recordCompletion = mocks.recordCompletion;
    findById = vi.fn(async () => undefined);
    sumChildUsage = vi.fn(async () => ({}));
    touchRunning = vi.fn(async () => true);
  },
}));
vi.mock('@/server/services/agent', () => ({
  AgentService: class {
    getAgentConfig = vi.fn(async () => ({
      chatConfig: { enableContextCompression: true },
      id: 'agent-1',
      model: 'gpt-4o',
      plugins: [],
      provider: 'openai',
      systemRole: '',
    }));
  },
}));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    queryAgents = vi.fn(async () => []);
  },
}));
vi.mock('@/database/models/aiModel', () => ({
  AiModelModel: class {
    findByIdAndProvider = vi.fn(async () => undefined);
  },
}));
vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    findById = vi.fn(async () => undefined);
  },
}));
vi.mock('@/business/client/model-bank/loadModels', () => ({
  loadModels: vi.fn(async () => []),
}));
vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: { isConfigured: false, queryDeviceList: vi.fn(async () => []) },
}));
vi.mock('@/server/services/workRegistration', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkRegistration>()),
  registerWorksForOperation: vi.fn(async () => ({ attempted: 0, failed: 0 })),
}));
vi.mock('@/database/models/work', () => ({
  WorkModel: class {
    listByRootOperation = vi.fn(async () => []);
  },
}));
vi.mock('@/server/services/agentRuntime/snapshotStore', () => ({
  createDefaultSnapshotStore: () => null,
}));

// Keep execAgent, its pipeline, AgentRuntimeService, executors and message
// adapters real. Only external configuration/storage and the model reply are fixtures.
describe('AiAgentService private transcript execution', () => {
  let service: AiAgentService;
  let stateManager: InMemoryAgentStateManager;
  let store: ChannelRuntimeMessageStore;
  let rows: UIChatMessage[];
  const channelContext = {
    artifactRunIds: ['published-run'],
    channelId: 'channel-1',
    fence: 3,
    runId: 'run-1',
  };
  const params = (): InternalExecAgentParams => ({
    agentId: 'agent-1',
    autoStart: false,
    channelContext,
    chatConfigOverride: { enableContextCompression: false },
    disableTools: true,
    prompt: '',
    serverToolManifests: [buildChannelArtifactManifest(channelContext.artifactRunIds)!],
    stream: false,
    transcript: { deliveryMessageId: 'delivery', load: () => store.query() },
    trigger: 'channel',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    rows = [
      {
        content: 'Earlier private answer',
        createdAt: 1,
        id: 'history',
        role: 'assistant',
        updatedAt: 1,
      },
      {
        content: 'Compare the proposals',
        createdAt: 2,
        id: 'delivery',
        role: 'user',
        updatedAt: 2,
      },
    ] as UIChatMessage[];
    store = new ChannelRuntimeMessageStore(
      {
        createMessage: async (row: UIChatMessage) => {
          rows.push(row);
          return row;
        },
        messages: async () => [...rows],
        updateMessage: async (id: string, update: (row: UIChatMessage) => UIChatMessage) => {
          rows = rows.map((row) => (row.id === id ? update(row) : row));
        },
      } as unknown as ChannelRuntimeModel,
      'owner',
      {} as never,
    );
    stateManager = new InMemoryAgentStateManager();
    service = new AiAgentService({} as never, 'owner', {
      runtimeOptions: {
        coordinatorOptions: { stateManager },
        messageStore: store,
        queueService: null,
        streamEventManager: new InMemoryStreamEventManager(),
      },
      withholdGatewayToken: true,
    });
    vi.spyOn(ServerLLMTransport.prototype, 'runAttempt').mockResolvedValue({
      ok: true,
      output: {
        answerSalvagedFromReasoning: false,
        content: 'Proposal B is easier to maintain.',
        contentParts: [{ text: 'Proposal B is easier to maintain.', type: 'text' }],
        finishReason: 'stop',
        grounding: null,
        hasContentImages: false,
        hasReasoningImages: false,
        imageList: [],
        reasoningParts: [],
        thinkingContent: '',
        toolCalls: [],
        toolsCalling: [],
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('carries Channel attachment content through execAgent and ordinary context engineering', async () => {
    rows[0] = { ...rows[0], role: 'user', files: ['proposal'], content: 'Attached proposal' };
    mocks.resolveFiles.mockResolvedValue({
      audioList: [],
      fileList: [
        {
          id: 'proposal',
          content: 'Maintenance budget is 47.',
          fileType: 'text/plain',
          name: 'proposal.txt',
          size: 25,
          url: '/signed-proposal',
        },
      ],
      imageList: [],
      videoList: [],
      warnings: [],
    });
    const result = await service.execAgent({
      ...params(),
      transcript: {
        deliveryMessageId: 'delivery',
        load: async () => store.resolveAttachments(await store.query()),
      },
    });
    expect(result.success).toBe(true);
    const state = await service.executeSync(result.operationId, { maxSteps: 5 });
    expect(state.status).toBe('done');
    const request = vi.mocked(ServerLLMTransport.prototype.runAttempt).mock.calls[0][0];
    expect(JSON.stringify(request)).toContain('Maintenance budget is 47.');
    expect(rows[0]).not.toHaveProperty('fileList');
    expect(rows[0].files).toEqual(['proposal']);
    expect(rows[1]).not.toHaveProperty('files');
    expect(mocks.messageQuery).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(mocks.topicCreate).not.toHaveBeenCalled();
  });

  it('starts and completes through the injected store without creating chat rows', async () => {
    const create = vi.spyOn(store, 'create');
    const result = await service.execAgent(params());
    expect(result).toMatchObject({
      assistantMessageId: '',
      success: true,
      topicId: '',
      userMessageId: 'delivery',
    });
    const initial = await stateManager.loadAgentState(result.operationId);
    expect(initial?.origin?.topicId).toBeUndefined();
    expect(initial?.principal?.actor?.channel).toEqual(channelContext);
    expect(initial?.messages.map(({ id }) => id)).toEqual(['history', 'delivery']);
    expect(initial?.world?.agent?.chatConfig?.enableContextCompression).toBe(false);
    expect(mocks.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: result.operationId, topicId: null }),
    );

    const state = await service.executeSync(result.operationId, { maxSteps: 5 });
    expect(state.status).toBe('done');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { operationId: result.operationId },
        parentId: 'delivery',
        role: 'assistant',
        topicId: undefined,
      }),
    );
    expect(rows.at(-1)).toMatchObject({
      content: 'Proposal B is easier to maintain.',
      metadata: { operationId: result.operationId },
      role: 'assistant',
    });
    expect(mocks.recordCompletion).toHaveBeenCalled();
    expect(mocks.topicCreate).not.toHaveBeenCalled();
    expect(mocks.topicUpdate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(mocks.messageQuery).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'honors the compression override for an oversized transcript (enabled=%s)',
    async (enabled) => {
      rows[0].content = 'Earlier context. '.repeat(100_000);
      const runner = vi.spyOn(GeneralChatAgent.prototype, 'runner');
      const result = await service.execAgent({
        ...params(),
        chatConfigOverride: { enableContextCompression: enabled },
      });

      const state = await service.executeSync(result.operationId, { maxSteps: 5 });
      expect(state.status).toBe('done');
      const instructions = await Promise.all(runner.mock.results.map(({ value }) => value));
      expect(instructions.map(({ type }) => type)).toEqual(
        enabled ? ['compress_context', 'call_llm', 'finish'] : ['call_llm', 'finish'],
      );
    },
  );

  it.each([
    { appContext: { topicId: 'chat-topic' } },
    { resume: true },
    {
      resumeApproval: {
        decision: 'approved' as const,
        parentMessageId: 'tool',
        toolCallId: 'call',
      },
    },
    {
      resumeApprovals: [
        { decision: 'approved' as const, parentMessageId: 'tool', toolCallId: 'call' },
      ],
    },
    { resumeToolResult: { content: 'answer', parentMessageId: 'tool', toolCallId: 'call' } },
  ])('rejects conflicting transcript parameters before starting: %j', async (conflict) => {
    await expect(service.execAgent({ ...params(), ...conflict })).rejects.toThrow(
      'transcript mode is exclusive',
    );
    expect(mocks.recordStart).not.toHaveBeenCalled();
    expect(mocks.topicCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });
});
