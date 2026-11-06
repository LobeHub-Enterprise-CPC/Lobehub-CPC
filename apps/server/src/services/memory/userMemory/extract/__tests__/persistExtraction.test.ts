// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { LobeChatTopicResultRecorder } from '@lobechat/memory-user-memory';
import type { ChatTopicMetadata } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { topics, userMemories, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type MemoryExtractionPrivateConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { LayersEnum, MemorySourceType, TypesEnum } from '@/types/userMemory';

import { MemoryExtractionExecutor } from '../index';

const serverDB: LobeChatDatabase = await getTestDB();

type RunState = NonNullable<ChatTopicMetadata['userMemoryExtractRunState']>;

const userId = 'memory-persist-user';
const topicId = 'memory-persist-topic';

const privateConfig: MemoryExtractionPrivateConfig = {
  agentBenchmarkLoCoMo: { model: 'benchmark-1', provider: 'provider-b' },
  agentGateKeeper: { model: 'gate-1', provider: 'provider-g' },
  agentLayerExtractor: {
    contextLimit: 2048,
    layers: {
      activity: 'layer-act',
      context: 'layer-ctx',
      experience: 'layer-exp',
      identity: 'layer-id',
      preference: 'layer-pref',
    },
    model: 'layer-1',
    provider: 'provider-l',
  },
  agentPersonaWriter: { model: 'persona-1', provider: 'provider-s' },
  concurrency: 1,
  embedding: { model: 'embed-1', provider: 'provider-e' },
  featureFlags: { enableBenchmarkLoCoMo: false },
  observabilityS3: { enabled: false },
  webhook: {},
};

const createExecutor = () => {
  // @ts-ignore accessing private constructor for testing
  const executor = new MemoryExtractionExecutor(
    { aiProvider: {}, memory: {} } as any,
    privateConfig,
  );
  const embeddings = vi.spyOn(executor as any, 'generateEmbeddings').mockResolvedValue([]);
  return Object.assign(executor, { embeddings });
};

const job = {
  source: MemorySourceType.ChatTopic,
  sourceId: topicId,
  sourceUpdatedAt: new Date('2026-11-06T00:00:00Z'),
  userId,
} as any;

const memoryServiceConfig = { modelConfig: { embeddingsModel: 'embed-1' } } as any;
const runtimes = { embeddings: {} } as any;

const contextMemory = (title: string) => ({
  details: `${title} details`,
  memoryCategory: 'work',
  memoryType: TypesEnum.Context,
  summary: `${title} summary`,
  title,
  withContext: { description: `${title} description`, labels: [], title },
});
const preferenceMemory = (title: string) => ({
  details: `${title} details`,
  memoryCategory: 'work',
  memoryType: TypesEnum.Preference,
  summary: `${title} summary`,
  title,
  withPreference: { conclusionDirectives: 'Prefer tea', extractedLabels: [] },
});

const outputs = {
  context: { data: { memories: [contextMemory('First'), contextMemory('Second')] } },
  preference: { data: { memories: [preferenceMemory('Tea')] } },
};

const persist = (
  executor: MemoryExtractionExecutor,
  layerOutputs: Record<string, unknown>,
  commit?: (tx: LobeChatDatabase, result: any) => Promise<void>,
  runtimeBundle: unknown = runtimes,
) =>
  (executor as any).persistExtraction(
    job,
    ['message-1'],
    { outputs: layerOutputs },
    runtimeBundle,
    memoryServiceConfig,
    serverDB,
    commit,
  );

const recorder = (currentMetadata: ChatTopicMetadata = {}) =>
  new LobeChatTopicResultRecorder({
    currentMetadata,
    database: serverDB,
    extractedThrough: '2026-11-06T00:00:00.000Z',
    lastMessageAt: '2026-11-06T00:00:00.000Z',
    messageCount: 2,
    previousExtractedThrough: currentMetadata.userMemoryExtractRunState?.extractedThrough,
    topicId,
  });
const completeWith =
  (topicRecorder: LobeChatTopicResultRecorder) => (tx: LobeChatDatabase, persisted: any) =>
    topicRecorder.recordComplete(
      job,
      { ...persisted, processedMemoryCount: persisted.createdIds.length },
      tx,
    );

const memoryTitles = async () =>
  (await serverDB.select({ title: userMemories.title }).from(userMemories))
    .map((row) => row.title)
    .sort();

const runState = async () =>
  (await serverDB.query.topics.findFirst({ where: eq(topics.id, topicId) }))?.metadata
    ?.userMemoryExtractRunState;
const watermark = async () => (await runState())?.extractedThrough;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await serverDB.delete(userMemories);
  await serverDB.delete(topics);
  await serverDB.delete(users);
  await serverDB.insert(users).values({ id: userId });
  await serverDB.insert(topics).values({ id: topicId, title: 'Topic', userId });
});

describe('persistExtraction', () => {
  it('writes every memory and the watermark together', async () => {
    const executor = createExecutor();
    const topicRecorder = recorder();

    const result = await persist(executor, outputs, (tx, persisted) =>
      topicRecorder.recordComplete(
        job,
        { ...persisted, processedMemoryCount: persisted.createdIds.length },
        tx,
      ),
    );

    expect(result.createdIds).toHaveLength(3);
    expect(result.layers).toEqual({ [LayersEnum.Context]: 2, [LayersEnum.Preference]: 1 });
    expect(await memoryTitles()).toEqual(['First', 'Second', 'Tea']);
    expect(await watermark()).toBe('2026-11-06T00:00:00.000Z');
  });

  it('keeps neither memories nor the watermark when the transaction fails after the watermark', async () => {
    const executor = createExecutor();
    const topicRecorder = recorder();

    await expect(
      persist(executor, outputs, async (tx, persisted) => {
        await topicRecorder.recordComplete(
          job,
          { ...persisted, processedMemoryCount: persisted.createdIds.length },
          tx,
        );
        throw new Error('connection lost before commit');
      }),
    ).rejects.toThrow('connection lost before commit');

    expect(await memoryTitles()).toEqual([]);
    expect(await watermark()).toBeUndefined();
  });

  it('writes nothing when a later layer fails to write', async () => {
    const executor = createExecutor();
    // The preference's summary vector has the wrong dimension: the database rejects its insert.
    executor.embeddings
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[1, 2, 3]]);
    const commit = vi.fn();

    await expect(persist(executor, outputs, commit)).rejects.toMatchObject({
      items: [expect.objectContaining({ layer: 'preferences', stage: 'persist' })],
    });
    expect(await memoryTitles()).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('writes nothing when an embedding fails, so a retry starts clean', async () => {
    const executor = createExecutor();
    executor.embeddings
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('embedding upstream 503'));
    const commit = vi.fn();

    await expect(persist(executor, outputs, commit)).rejects.toThrow('embedding upstream 503');
    expect(await memoryTitles()).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('writes nothing when a layer failed to extract', async () => {
    const executor = createExecutor();
    const commit = vi.fn();

    await expect(
      persist(executor, { ...outputs, activity: { error: new Error('model refused') } }, commit),
    ).rejects.toMatchObject({
      items: [expect.objectContaining({ layer: 'activities', stage: 'extract' })],
    });
    expect(await memoryTitles()).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('skips an activity the model returned malformed and keeps the rest', async () => {
    const executor = createExecutor();
    const commit = vi.fn();

    const result = await persist(
      executor,
      { ...outputs, activity: { data: { memories: [{ title: 'No timeline' }] } } },
      commit,
    );

    expect(result.layers).toEqual({
      [LayersEnum.Activity]: 0,
      [LayersEnum.Context]: 2,
      [LayersEnum.Preference]: 1,
    });
    expect(await memoryTitles()).toEqual(['First', 'Second', 'Tea']);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('writes nothing when the embedding service fails behind the real helper', async () => {
    // No spy on generateEmbeddings: the request goes through the helper to the runtime.
    // @ts-ignore accessing private constructor for testing
    const executor = new MemoryExtractionExecutor(
      { aiProvider: {}, memory: {} } as any,
      privateConfig,
    );
    const embeddings = vi.fn().mockRejectedValue(new Error('embedding upstream 503'));
    const commit = vi.fn();

    await expect(
      persist(executor, outputs, commit, { embeddings: { embeddings } }),
    ).rejects.toThrow('embedding upstream 503');
    expect(embeddings).toHaveBeenCalled();
    expect(await memoryTitles()).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('writes nothing when the embedding service returns fewer vectors than asked', async () => {
    // @ts-ignore accessing private constructor for testing
    const executor = new MemoryExtractionExecutor(
      { aiProvider: {}, memory: {} } as any,
      privateConfig,
    );
    const commit = vi.fn();

    await expect(
      persist(executor, outputs, commit, {
        embeddings: { embeddings: vi.fn().mockResolvedValue([]) },
      }),
    ).rejects.toThrow();
    expect(await memoryTitles()).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rolls the memories back when the watermark update matches no topic', async () => {
    const executor = createExecutor();
    const topicRecorder = recorder();
    await serverDB.delete(topics);

    await expect(persist(executor, outputs, completeWith(topicRecorder))).rejects.toThrow();
    expect(await memoryTitles()).toEqual([]);
  });

  it('keeps a committed watermark when the failure is recorded afterwards', async () => {
    const executor = createExecutor();
    const previous: ChatTopicMetadata = {
      userMemoryExtractRunState: { extractedThrough: '2026-11-05T00:00:00.000Z' },
      userMemoryExtractStatus: 'completed',
    };
    await serverDB.update(topics).set({ metadata: previous }).where(eq(topics.id, topicId));
    const topicRecorder = recorder(previous);

    // The commit reached the database; the caller then saw an error and records a failure.
    await persist(executor, outputs, completeWith(topicRecorder));
    await topicRecorder.recordFail(job, new Error('connection lost after COMMIT'));

    expect(await watermark()).toBe('2026-11-06T00:00:00.000Z');
    expect(await memoryTitles()).toEqual(['First', 'Second', 'Tea']);
  });

  it('counts a failure after a rolled-back watermark on top of earlier failures', async () => {
    const executor = createExecutor();
    const previous: ChatTopicMetadata = {
      userMemoryExtractRunState: {
        error: 'earlier',
        extractedThrough: '2026-11-05T00:00:00.000Z',
        failedRuns: 3,
        lastMessageAt: '2026-11-06T00:00:00.000Z',
        lastRunAt: '2026-11-06T01:00:00.000Z',
      },
      userMemoryExtractStatus: 'failed',
    };
    await serverDB.update(topics).set({ metadata: previous }).where(eq(topics.id, topicId));
    const topicRecorder = recorder(previous);

    await expect(
      persist(executor, outputs, async (tx, persisted) => {
        await completeWith(topicRecorder)(tx, persisted);
        throw new Error('connection lost before commit');
      }),
    ).rejects.toThrow('connection lost before commit');
    await topicRecorder.recordFail(job, new Error('connection lost before commit'));

    expect(await runState()).toMatchObject({
      extractedThrough: '2026-11-05T00:00:00.000Z',
      failedRuns: 4,
    });
    expect(await memoryTitles()).toEqual([]);
  });
});

describe('LobeChatTopicResultRecorder.recordFail', () => {
  const failing = async (
    runState: RunState,
    lastMessageAt: string,
    status: ChatTopicMetadata['userMemoryExtractStatus'] = 'failed',
  ) => {
    const metadata: ChatTopicMetadata = {
      userMemoryExtractRunState: runState,
      userMemoryExtractStatus: status,
    };
    await serverDB.update(topics).set({ metadata }).where(eq(topics.id, topicId));
    const topicRecorder = new LobeChatTopicResultRecorder({
      currentMetadata: metadata,
      database: serverDB,
      extractedThrough: '2026-11-06T00:00:00.000Z',
      lastMessageAt,
      previousExtractedThrough: runState.extractedThrough,
      topicId,
    });
    await topicRecorder.recordFail(job, new Error('504 Gateway Time-out'));
    return runState;
  };

  it('keeps the watermark where it was, so a retry resumes there', async () => {
    await failing({ extractedThrough: '2026-11-05T00:00:00.000Z' }, '2026-11-06T00:00:00.000Z');
    expect(await runState()).toMatchObject({
      error: '504 Gateway Time-out',
      extractedThrough: '2026-11-05T00:00:00.000Z',
    });
  });

  it('keeps the progress of a topic completed before the watermark existed', async () => {
    // Completed earlier with only lastMessageAt; a new segment then fails.
    await failing(
      { lastMessageAt: '2026-11-05T00:00:00.000Z' },
      '2026-11-06T00:00:00.000Z',
      'completed',
    );
    expect(await runState()).toMatchObject({
      extractedThrough: '2026-11-05T00:00:00.000Z',
      failedRuns: 1,
    });
  });

  it('leaves no watermark on a topic that never had one', async () => {
    await failing({}, '2026-11-06T00:00:00.000Z');
    expect(await runState()).not.toHaveProperty('extractedThrough');
    expect(await runState()).toMatchObject({ failedRuns: 1 });
  });

  it('counts consecutive failed runs on a conversation that has not moved', async () => {
    await failing(
      {
        failedRuns: 2,
        lastMessageAt: '2026-11-05T09:00:00.000Z',
        lastRunAt: '2026-11-05T12:00:00.000Z',
      },
      '2026-11-05T09:00:00.000Z',
    );
    expect(await runState()).toMatchObject({ failedRuns: 3 });
  });

  it('starts the failure count over when new conversation arrived since the last run', async () => {
    await failing(
      { failedRuns: 4, lastRunAt: '2026-11-05T12:00:00.000Z' },
      '2026-11-06T08:00:00.000Z',
    );
    expect(await runState()).toMatchObject({ failedRuns: 1 });
  });
});
