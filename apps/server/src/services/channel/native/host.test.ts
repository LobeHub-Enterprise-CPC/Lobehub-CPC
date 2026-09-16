// @vitest-environment node
import type { AgentState } from '@lobechat/agent-runtime';
import type { UIChatMessage } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelBudget } from '../budget';
import { runChannelNative } from './host';

const mocks = vi.hoisted(() => ({
  execAgent: vi.fn(),
  executeSync: vi.fn(),
  interruptOperation: vi.fn(),
  resolveFiles: vi.fn(),
  save: vi.fn(),
  serviceOptions: vi.fn(),
}));
type PrivateRow = UIChatMessage & { clientId?: string };
let messages: PrivateRow[];
let checkpoint: Record<string, unknown> | undefined;
const manifest = {
  cutoffSequence: 2,
  messages: [
    {
      author: { id: 'human', type: 'human' },
      content: 'Please compare the two proposals',
      fileIds: ['proposal'],
      id: 'request',
      sequence: 1,
      threadId: null,
    },
    {
      author: { id: 'peer', type: 'member' },
      content: 'Proposal A is cheaper',
      id: 'peer-1',
      sequence: 2,
      threadId: null,
    },
  ],
  requestMessageId: 'request',
  self: { memberId: 'member' },
  source: 'delta',
  threadId: null,
};
vi.mock('@/database/models/channelRuntime', () => ({
  ChannelRuntimeModel: class {
    load = async () => ({
      checkpoint,
      run: { channelId: 'channel', fence: 1, id: 'run', manifest, sessionId: 'session' },
    });
    messages = async () => [...messages];
    createMessage = async (message: UIChatMessage, stableKey: string) => {
      const existing = messages.find((item) => item.clientId === stableKey);
      if (existing) return existing;
      messages.push({ ...message, clientId: stableKey });
      return message;
    };
    save = mocks.save;
  },
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    constructor(...args: unknown[]) {
      mocks.serviceOptions(...args);
    }
    execAgent = mocks.execAgent;
    executeSync = mocks.executeSync;
    interruptOperation = mocks.interruptOperation;
  },
}));
vi.mock('@/server/services/file/resolveAttachments', () => ({
  resolveAttachmentsByFileIds: mocks.resolveFiles,
}));

const done = (overrides: Partial<AgentState> = {}) =>
  ({
    modelRuntimeConfig: { model: 'gpt', provider: 'openai' },
    status: 'done',
    usage: { llm: { apiCalls: 2 }, tools: { totalCalls: 1 } },
    ...overrides,
  }) as AgentState;
const assistant = (content: string, extra: Partial<UIChatMessage> = {}): UIChatMessage =>
  ({
    content,
    createdAt: Date.now(),
    id: `asst_${content}`,
    metadata: { operationId: 'op_1' },
    role: 'assistant',
    updatedAt: Date.now(),
    ...extra,
  }) as UIChatMessage;
const base = () => ({
  agentId: 'agent',
  artifactRunIds: ['run-a'],
  db: {} as LobeChatDatabase,
  onAccepted: vi.fn(),
  ownerId: 'owner',
  run: { channelId: 'channel', fence: 1, id: 'run' },
  signal: new AbortController().signal,
});

beforeEach(() => {
  vi.clearAllMocks();
  messages = [];
  checkpoint = undefined;
  mocks.execAgent.mockResolvedValue({ operationId: 'op_1', success: true });
  mocks.interruptOperation.mockResolvedValue(true);
  mocks.resolveFiles.mockResolvedValue({
    audioList: [],
    fileList: [{ id: 'proposal', content: 'Proposal contents', url: '/signed-proposal' }],
    imageList: [],
    videoList: [],
    warnings: [],
  });
});

describe('runChannelNative', () => {
  it('runs the member through execAgent in headless transcript mode and returns the final', async () => {
    mocks.executeSync.mockImplementation(async () => {
      messages.push(
        assistant('thinking', { tools: [{ id: 'call' }] as UIChatMessage['tools'] }),
        assistant('Proposal B wins on maintenance'),
      );
      return done();
    });
    const input = base();
    const result = await runChannelNative(input);

    // Private transcript only: no topic, resume or `messages` row is involved.
    const [options] = mocks.serviceOptions.mock.calls[0].slice(2) as [
      { runtimeOptions: Record<string, unknown>; withholdGatewayToken: boolean },
    ];
    expect(options.withholdGatewayToken).toBe(true);
    expect(options.runtimeOptions.queueService).toBeNull();
    expect(options.runtimeOptions.messageStore).toBeDefined();
    const params = mocks.execAgent.mock.calls[0][0];
    expect(params).toMatchObject({
      agentId: 'agent',
      autoStart: false,
      channelContext: { artifactRunIds: ['run-a'], channelId: 'channel', fence: 1, runId: 'run' },
      chatConfigOverride: { enableContextCompression: false },
      stream: false,
      trigger: 'channel',
      userInterventionConfig: { approvalMode: 'headless' },
    });
    expect(params.appContext?.topicId).toBeUndefined();
    expect(params.resumeOperationId).toBeUndefined();
    expect(params.serverToolManifests?.[0]?.identifier).toBe('channel-artifact');
    expect(params.instructions).toContain('activeRequestMessageId');

    // Public history and the delivery row are the transcript execAgent reads.
    const transcript = await params.transcript.load();
    expect(transcript[0]).toMatchObject({
      files: ['proposal'],
      fileList: [
        expect.objectContaining({ content: 'Proposal contents', url: '/signed-proposal' }),
      ],
    });
    expect(messages[0]).toHaveProperty('files', ['proposal']);
    expect(messages[0]).not.toHaveProperty('fileList');
    expect(transcript.map((message: PrivateRow) => message.clientId)).toEqual([
      'public:request',
      'public:peer-1',
      'delivery:run',
      undefined,
      undefined,
    ]);
    expect(params.transcript.deliveryMessageId).toBe(transcript[2].id);
    expect(JSON.parse(transcript[2].content)).toMatchObject({
      activeRequestMessageId: 'request',
      kind: 'channel_request',
    });

    expect(mocks.save).toHaveBeenCalledWith({
      operationId: 'op_1',
      phase: 'accepted',
      runId: 'run',
    });
    expect(input.onAccepted).toHaveBeenCalledWith('session', 'op_1');
    expect(result).toMatchObject({
      budget: { modelCalls: 2, toolCalls: 1 },
      content: 'Proposal B wins on maintenance',
      operationId: 'op_1',
    });
  });

  it('refuses to resubmit a run whose operation already exists', async () => {
    checkpoint = { operationId: 'op_0', phase: 'accepted', runId: 'run' };
    await expect(runChannelNative(base())).rejects.toThrow('checkpoint exists');
    expect(mocks.execAgent).not.toHaveBeenCalled();
  });

  it('interrupts the operation once the step counters reach the Channel limit', async () => {
    mocks.executeSync.mockImplementation(async (_id, { onStepComplete }) => {
      await onStepComplete(0, {
        status: 'running',
        usage: { llm: { apiCalls: 32 }, tools: { totalCalls: 0 } },
      } as AgentState);
      return done({
        status: 'interrupted',
        usage: { llm: { apiCalls: 32 }, tools: { totalCalls: 0 } } as AgentState['usage'],
      });
    });
    await expect(runChannelNative(base())).rejects.toThrow('Channel model call limit reached');
    expect(mocks.interruptOperation).toHaveBeenCalledWith('op_1');
  });

  it('interrupts the operation when the caller aborts', async () => {
    const controller = new AbortController();
    mocks.executeSync.mockImplementation(async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return done({ status: 'interrupted' });
    });
    await expect(runChannelNative({ ...base(), signal: controller.signal })).rejects.toThrow(
      'Native execution was interrupted',
    );
    expect(mocks.interruptOperation).toHaveBeenCalledWith('op_1');
  });

  it('reports a headless approval request as a failure instead of waiting', async () => {
    mocks.executeSync.mockResolvedValue(done({ status: 'waiting_for_human' }));
    await expect(runChannelNative(base())).rejects.toThrow('headless');
  });

  it('surfaces the runtime error', async () => {
    mocks.executeSync.mockResolvedValue(
      done({ error: new Error('Provider quota exhausted'), status: 'error' }),
    );
    await expect(runChannelNative(base())).rejects.toThrow('Provider quota exhausted');
  });

  it('fails when execAgent could not start the operation', async () => {
    mocks.execAgent.mockResolvedValue({ error: 'Queue unavailable', success: false });
    await expect(runChannelNative(base())).rejects.toThrow('Queue unavailable');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('ignores assistant rows from other operations when picking the final', async () => {
    messages.push(assistant('stale', { metadata: { operationId: 'op_0' } }));
    mocks.executeSync.mockResolvedValue(done());
    await expect(runChannelNative(base())).rejects.toThrow('without a publishable final');
  });

  it('rejects before starting when the time budget is already spent', async () => {
    let now = 0;
    const budget = new ChannelBudget(() => now);
    now = 11 * 60 * 1000;
    await expect(runChannelNative({ ...base(), budget })).rejects.toThrow('time limit');
    expect(mocks.execAgent).not.toHaveBeenCalled();
  });
});
