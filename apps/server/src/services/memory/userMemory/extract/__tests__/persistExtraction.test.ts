// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { LobeChatTopicResultRecorder } from '@lobechat/memory-user-memory';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { topics, userMemories, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type MemoryExtractionPrivateConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { LayersEnum, MemorySourceType, TypesEnum } from '@/types/userMemory';

import { MemoryExtractionExecutor } from '../index';

const serverDB: LobeChatDatabase = await getTestDB();

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
) =>
  (executor as any).persistExtraction(
    job,
    ['message-1'],
    { outputs: layerOutputs },
    runtimes,
    memoryServiceConfig,
    serverDB,
    commit,
  );

const recorder = () =>
  new LobeChatTopicResultRecorder({
    currentMetadata: {},
    database: serverDB,
    extractedThrough: '2026-11-06T00:00:00.000Z',
    lastMessageAt: '2026-11-06T00:00:00.000Z',
    messageCount: 2,
    topicId,
  });

const memoryTitles = async () =>
  (await serverDB.select({ title: userMemories.title }).from(userMemories))
    .map((row) => row.title)
    .sort();

const watermark = async () =>
  (await serverDB.query.topics.findFirst({ where: eq(topics.id, topicId) }))?.metadata
    ?.userMemoryExtractRunState?.extractedThrough;

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
});
