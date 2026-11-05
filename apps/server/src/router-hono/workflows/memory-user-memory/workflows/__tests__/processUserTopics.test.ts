import { LayersEnum, MemorySourceType } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStepRunner } from '@/server/workflows/testing/stepContext';

import { processUserTopicsHandler } from '../processUserTopics';

const mocks = vi.hoisted(() => ({
  acquireUserRunLease: vi.fn(),
  appendHourlyWorkflowRunId: vi.fn(),
  extractTopic: vi.fn(),
  filterTopicIdsForUser: vi.fn(),
  getTopicsForUser: vi.fn(),
  holdUserRunLease: vi.fn(),
  isHourlyMemoryExtractionCancelled: vi.fn(),
  releaseUserRunLease: vi.fn(),
  triggerPersonaUpdate: vi.fn(),
}));

// NOTICE: The module reads MAX_TOPICS_PER_USER_PER_RUN from this config at import time, so the cap
// is fixed to 4 for the whole file to keep the fixtures small.
vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () => ({
    upstashWorkflowExtraHeaders: { 'x-extra': '1' },
    workflow: { maxTopicsPerUserPerRun: 4 },
  }),
}));

vi.mock('@/server/services/memory/userMemory/extract', () => ({
  MemoryExtractionExecutor: {
    create: async () => ({
      extractTopic: mocks.extractTopic,
      filterTopicIdsForUser: mocks.filterTopicIdsForUser,
      getTopicsForUser: mocks.getTopicsForUser,
    }),
  },
  MemoryExtractionWorkflowService: { triggerPersonaUpdate: mocks.triggerPersonaUpdate },
  normalizeMemoryExtractionPayload: (payload: Record<string, unknown>) => ({
    ...payload,
    layers: payload.layers ?? [],
    sources: payload.sources ?? [],
    topicIds: payload.topicIds ?? [],
    userIds: payload.userIds ?? [],
  }),
}));

vi.mock('@/database/models/asyncTask', () => ({ AsyncTaskModel: class {} }));
vi.mock('@/database/server', () => ({ getServerDB: vi.fn() }));

vi.mock('../runGuard', () => ({
  checkGuard: vi.fn().mockResolvedValue({ result: true }),
  ensureWorkflowStarted: vi.fn().mockResolvedValue({ started: true }),
}));

vi.mock('@/server/services/redis', () => ({
  redisService: {
    userMemoryExtractionLease: {
      acquire: mocks.acquireUserRunLease,
      hold: mocks.holdUserRunLease,
      release: mocks.releaseUserRunLease,
    },
  },
}));

vi.mock('../utils', () => ({
  appendHourlyWorkflowRunId: mocks.appendHourlyWorkflowRunId,
  isHourlyMemoryExtractionCancelled: mocks.isHourlyMemoryExtractionCancelled,
}));

const createContext = (payload: Record<string, unknown> = {}) => ({
  requestPayload: { ...basePayload, ...payload },
  run: createStepRunner(),
  sleep: vi.fn(async () => {}),
  workflowRunId: 'run-1',
});

const basePayload = {
  baseUrl: 'https://app.example.com',
  hourlyTaskId: 'hourly-1',
  sources: [MemorySourceType.ChatTopic],
  userIds: ['u1'],
};

const extracted = (memoryIds: string[] = [], more?: { extractedThrough: string }) => ({
  extractedThrough: more?.extractedThrough,
  hasMore: !!more,
  memoryIds,
});

const extractedTopics = () => mocks.extractTopic.mock.calls.map(([job]) => job.topicId);

describe('processUserTopicsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireUserRunLease.mockResolvedValue(true);
    mocks.holdUserRunLease.mockResolvedValue(true);
    mocks.isHourlyMemoryExtractionCancelled.mockResolvedValue(false);
    mocks.filterTopicIdsForUser.mockImplementation(async (_userId, topicIds: string[]) => topicIds);
    mocks.getTopicsForUser.mockResolvedValue({ ids: ['t1', 't2'] });
    mocks.extractTopic.mockResolvedValue(extracted());
    mocks.triggerPersonaUpdate.mockResolvedValue({ workflowRunId: 'persona-run' });
  });

  it('extracts the user topics one after another, every layer in one call, under the user lease', async () => {
    const context = createContext();

    await processUserTopicsHandler(context as never);

    expect(extractedTopics()).toEqual(['t1', 't2']);
    expect(mocks.extractTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        layers: [
          LayersEnum.Context,
          LayersEnum.Preference,
          LayersEnum.Activity,
          LayersEnum.Identity,
        ],
        resumeFrom: undefined,
        source: MemorySourceType.ChatTopic,
        topicId: 't1',
        userId: 'u1',
      }),
    );
    expect(mocks.acquireUserRunLease).toHaveBeenCalledWith('u1', 'run-1');
    expect(mocks.releaseUserRunLease).toHaveBeenCalledWith('u1', 'run-1');
    // Released only after the last topic.
    expect(mocks.releaseUserRunLease.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.extractTopic.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('refreshes the persona once per user, and only when something new was remembered', async () => {
    mocks.extractTopic
      .mockResolvedValueOnce(extracted(['m1']))
      .mockResolvedValueOnce(extracted(['m2']));

    await processUserTopicsHandler(createContext() as never);

    expect(mocks.triggerPersonaUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.triggerPersonaUpdate).toHaveBeenCalledWith('u1', 'https://app.example.com', {
      extraHeaders: { 'x-extra': '1' },
      hourlyTaskId: 'hourly-1',
    });
    expect(mocks.appendHourlyWorkflowRunId).toHaveBeenCalledWith('hourly-1', 'persona-run');

    vi.clearAllMocks();
    mocks.extractTopic.mockResolvedValue(extracted());
    await processUserTopicsHandler(createContext() as never);

    expect(mocks.triggerPersonaUpdate).not.toHaveBeenCalled();
  });

  it('works through a long backlog segment by segment, resuming from each watermark', async () => {
    mocks.getTopicsForUser.mockResolvedValue({ ids: ['t1'] });
    mocks.extractTopic
      .mockResolvedValueOnce(extracted(['m1'], { extractedThrough: '2026-11-05T01:00:00.000Z' }))
      .mockResolvedValueOnce(extracted([], { extractedThrough: '2026-11-05T02:00:00.000Z' }))
      .mockResolvedValueOnce(extracted(['m2']));

    await processUserTopicsHandler(createContext() as never);

    expect(mocks.extractTopic.mock.calls.map(([job]) => job.resumeFrom)).toEqual([
      undefined,
      '2026-11-05T01:00:00.000Z',
      '2026-11-05T02:00:00.000Z',
    ]);
  });

  it('leaves the rest of a huge backlog to a later run after a few segments', async () => {
    mocks.getTopicsForUser.mockResolvedValue({ ids: ['huge', 't2'] });
    mocks.extractTopic.mockImplementation(async ({ topicId }) =>
      topicId === 'huge'
        ? extracted([], { extractedThrough: '2026-11-05T01:00:00.000Z' })
        : extracted(),
    );

    await processUserTopicsHandler(createContext() as never);

    expect(extractedTopics()).toEqual(['huge', 'huge', 'huge', 'huge', 'huge', 't2']);
  });

  it('goes on with the next topic when one fails', async () => {
    mocks.extractTopic
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce(extracted(['m1']));

    const result = await processUserTopicsHandler(createContext() as never);

    expect(extractedTopics()).toEqual(['t1', 't2']);
    expect(mocks.triggerPersonaUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUserRunLease).toHaveBeenCalled();
    expect(result).toMatchObject({ users: { u1: { createdMemories: 1, processedTopics: 2 } } });
  });

  it('pages through the user topics within the run up to the per-run ceiling', async () => {
    mocks.getTopicsForUser
      .mockResolvedValueOnce({
        cursor: { createdAt: new Date('2024-07-02T09:36:44.073Z'), id: 't3' },
        ids: ['t1', 't2', 't3'],
      })
      .mockResolvedValueOnce({
        cursor: { createdAt: new Date('2024-07-03T00:00:00.000Z'), id: 't6' },
        ids: ['t4', 't5', 't6'],
      });

    await processUserTopicsHandler(createContext() as never);

    expect(extractedTopics()).toEqual(['t1', 't2', 't3', 't4']);
    expect(mocks.getTopicsForUser).toHaveBeenCalledTimes(2);
    // The cursor crossed a step boundary as a string and is handed back as a Date.
    expect(mocks.getTopicsForUser.mock.calls[1][0].cursor).toEqual({
      createdAt: new Date('2024-07-02T09:36:44.073Z'),
      id: 't3',
    });
  });

  it('extracts every explicitly requested topic, uncapped and without listing', async () => {
    await processUserTopicsHandler(
      createContext({ topicIds: ['a', 'b', 'c', 'd', 'e'], userInitiated: true }) as never,
    );

    expect(mocks.getTopicsForUser).not.toHaveBeenCalled();
    expect(extractedTopics()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('leaves a user already being worked on to the next hourly run', async () => {
    mocks.acquireUserRunLease.mockResolvedValue(false);
    const context = createContext();

    const result = await processUserTopicsHandler(context as never);

    expect(mocks.extractTopic).not.toHaveBeenCalled();
    expect(context.sleep).not.toHaveBeenCalled();
    expect(mocks.releaseUserRunLease).not.toHaveBeenCalled();
    expect(result).toMatchObject({ users: { u1: { skipped: expect.any(String) } } });
  });

  it('keeps the lease alive before every segment of a long run', async () => {
    await processUserTopicsHandler(createContext() as never);

    expect(mocks.holdUserRunLease).toHaveBeenCalledTimes(2);
    expect(mocks.holdUserRunLease).toHaveBeenCalledWith('u1', 'run-1');
    expect(mocks.holdUserRunLease.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.extractTopic.mock.invocationCallOrder[0],
    );
  });

  it('stops when another run took the user over, instead of extracting the same topics twice', async () => {
    // The lease lapsed during a very long run and the next hourly run took it.
    mocks.holdUserRunLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await processUserTopicsHandler(createContext() as never);

    expect(extractedTopics()).toEqual(['t1']);
    expect((result as any).users.u1).toMatchObject({ processedTopics: 1, stopped: 'lease' });
    // Never gives back a lease that is someone else's now.
    expect(mocks.releaseUserRunLease).not.toHaveBeenCalled();
  });

  it('makes a user-initiated run wait for the lease instead of skipping', async () => {
    mocks.acquireUserRunLease
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const context = createContext({ userInitiated: true });

    await processUserTopicsHandler(context as never);

    expect(context.sleep).toHaveBeenCalledTimes(2);
    expect(context.sleep).toHaveBeenCalledWith(expect.stringContaining('lease-wait'), 60);
    expect(extractedTopics()).toEqual(['t1', 't2']);
  });

  it('lets a user-initiated run that went ahead without the lease keep going', async () => {
    mocks.acquireUserRunLease.mockResolvedValue(false);
    mocks.holdUserRunLease.mockResolvedValue(false);

    await processUserTopicsHandler(createContext({ userInitiated: true }) as never);

    expect(extractedTopics()).toEqual(['t1', 't2']);
    expect(mocks.holdUserRunLease).not.toHaveBeenCalled();
  });

  it('stops before extracting anything once the hourly task is cancelled', async () => {
    mocks.isHourlyMemoryExtractionCancelled.mockResolvedValue(true);

    await processUserTopicsHandler(createContext() as never);

    expect(mocks.acquireUserRunLease).not.toHaveBeenCalled();
    expect(mocks.extractTopic).not.toHaveBeenCalled();
  });

  it('stops between topics once the hourly task is cancelled, and gives the lease back', async () => {
    mocks.isHourlyMemoryExtractionCancelled
      .mockResolvedValueOnce(false) // user start
      .mockResolvedValueOnce(false) // before t1
      .mockResolvedValue(true);

    await processUserTopicsHandler(createContext() as never);

    expect(extractedTopics()).toEqual(['t1']);
    expect(mocks.releaseUserRunLease).toHaveBeenCalledWith('u1', 'run-1');
  });

  it('has nothing to do for a request naming only the retired Experience layer', async () => {
    const result = await processUserTopicsHandler(
      createContext({ layers: [LayersEnum.Experience] }) as never,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(mocks.extractTopic).not.toHaveBeenCalled();
  });

  it('logs what each segment and the user run came to', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.extractTopic
      .mockResolvedValueOnce({ ...extracted(['m1']), extracted: true })
      .mockResolvedValueOnce({ ...extracted(), extracted: false, reason: 'nothing_new' });

    await processUserTopicsHandler(createContext() as never);

    const lines = info.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(lines).toEqual([
      expect.objectContaining({
        event: 'memory.topic',
        memories: 1,
        outcome: 'extracted',
        topicId: 't1',
      }),
      expect.objectContaining({
        event: 'memory.topic',
        memories: 0,
        outcome: 'nothing_new',
        topicId: 't2',
      }),
      expect.objectContaining({
        event: 'memory.run',
        memories: 1,
        outcome: 'done',
        runId: 'run-1',
        topics: 2,
        userId: 'u1',
      }),
    ]);
    info.mockRestore();
  });

  it('logs a user left to the next run because another run holds the lease', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.acquireUserRunLease.mockResolvedValue(false);

    await processUserTopicsHandler(createContext() as never);

    expect(JSON.parse(info.mock.calls[0][0] as string)).toMatchObject({
      event: 'memory.run',
      outcome: 'skipped:lease',
      userId: 'u1',
    });
    info.mockRestore();
  });
});
