// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STALE_RUNNING_TOPIC_MS,
  StaleRunningTopicSweeper,
  topicStatusForTerminalOperation,
} from '../staleRunningTopicSweeper';

const settleRunningOperationMock = vi.fn();
const topicModelConstructorMock = vi.fn();

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(function (this: unknown, ...args: unknown[]) {
    topicModelConstructorMock(...args);

    return { settleRunningOperation: settleRunningOperationMock };
  }),
}));

/**
 * Minimal drizzle chains for the sweep's two reads, in call order:
 *
 * 1. candidates — `select().from(topics).where()...orderBy()...limit()`
 * 2. operation statuses — `select().from(agentOperations).where()`
 *
 * Both are mocked off the read order rather than off the table symbol so the
 * sweep's own sequencing is what the assertions ride on.
 */
const buildDb = (candidates: any[], operationRows: any[] = []) => {
  let reads = 0;

  return {
    select: () => ({
      from: () => {
        reads += 1;

        return reads === 1
          ? {
              where: () => ({ orderBy: () => ({ limit: vi.fn().mockResolvedValue(candidates) }) }),
            }
          : { where: vi.fn().mockResolvedValue(operationRows) };
      },
    }),
  } as any;
};

const staleAt = new Date(Date.now() - DEFAULT_STALE_RUNNING_TOPIC_MS - 60_000);

const candidateRow = (overrides: Record<string, any> = {}) => ({
  id: 'tpc_1',
  operationId: 'op_1',
  updatedAt: staleAt,
  userId: 'user_1',
  workspaceId: null,
  ...overrides,
});

const buildSweeper = (candidates: any[], operationRows: any[]) =>
  new StaleRunningTopicSweeper(buildDb(candidates, operationRows));

const settleResult = (status: 'conflict' | 'corrected' | 'missing' | 'settled') => ({ status });

describe('StaleRunningTopicSweeper', () => {
  beforeEach(() => {
    settleRunningOperationMock.mockReset().mockResolvedValue(settleResult('settled'));
    topicModelConstructorMock.mockReset();
  });

  describe('topicStatusForTerminalOperation', () => {
    it('mirrors the client status for each terminal outcome', () => {
      // The only terminal status whose result the user has not necessarily seen.
      expect(topicStatusForTerminalOperation('done')).toBe('unread');
      // Visible interruptions the user already saw — same split the client and
      // `agentNotify` use.
      expect(topicStatusForTerminalOperation('interrupted')).toBe('active');
      expect(topicStatusForTerminalOperation('error')).toBe('active');
      expect(topicStatusForTerminalOperation('abandoned')).toBe('active');
    });
  });

  it('settles a topic whose marker names an interrupted operation', async () => {
    const sweeper = buildSweeper([candidateRow()], [{ id: 'op_1', status: 'interrupted' }]);

    const result = await sweeper.sweep();

    expect(result).toMatchObject({
      budgetExhausted: false,
      clearable: 1,
      examined: 1,
      failed: 0,
      live: 0,
      settled: 1,
      skipped: 0,
      unknown: 0,
    });
    expect(settleRunningOperationMock).toHaveBeenCalledWith('tpc_1', 'op_1', 'active');
  });

  it('settles a finished run to unread, matching the server-side terminal path', async () => {
    const sweeper = buildSweeper([candidateRow()], [{ id: 'op_1', status: 'done' }]);

    await sweeper.sweep();

    expect(settleRunningOperationMock).toHaveBeenCalledWith('tpc_1', 'op_1', 'unread');
  });

  it('settles under the topic owner with visitor topics visible', async () => {
    const sweeper = buildSweeper(
      [candidateRow({ userId: 'user_9', workspaceId: 'ws_1' })],
      [{ id: 'op_1', status: 'interrupted' }],
    );

    await sweeper.sweep();

    const [db, userId, workspaceId, ftsSource, options] = topicModelConstructorMock.mock.calls[0];
    expect(db).toBeDefined();
    expect(userId).toBe('user_9');
    expect(workspaceId).toBe('ws_1');
    expect(ftsSource).toBeUndefined();
    // A share visitor's topic row is owned by the creator, so the default scope
    // would hide it and report `missing` forever.
    expect(options).toEqual({ includeShareVisitor: true });
  });

  describe('leaves rows alone unless the run is provably over', () => {
    it.each(['idle', 'running', 'waiting_for_async_tool', 'waiting_for_client', 'waiting_for_human'])(
      'keeps the marker while the operation is %s',
      async (status) => {
        const sweeper = buildSweeper([candidateRow()], [{ id: 'op_1', status }]);

        const result = await sweeper.sweep();

        expect(result).toMatchObject({ clearable: 0, live: 1, settled: 0 });
        expect(settleRunningOperationMock).not.toHaveBeenCalled();
      },
    );

    it('keeps the marker when the operation row is gone', async () => {
      const sweeper = buildSweeper([candidateRow()], []);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ clearable: 0, settled: 0, unknown: 1 });
      expect(settleRunningOperationMock).not.toHaveBeenCalled();
    });

    it('ignores a terminal operation that belongs to a different topic', async () => {
      const sweeper = buildSweeper(
        [candidateRow({ id: 'tpc_1', operationId: 'op_1' }), candidateRow({ id: 'tpc_2', operationId: 'op_2' })],
        [{ id: 'op_1', status: 'interrupted' }],
      );

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ examined: 2, settled: 1, unknown: 1 });
      expect(settleRunningOperationMock).toHaveBeenCalledTimes(1);
      expect(settleRunningOperationMock).toHaveBeenCalledWith('tpc_1', 'op_1', 'active');
    });
  });

  it('counts a marker another writer already removed as skipped, not failed', async () => {
    const sweeper = buildSweeper([candidateRow()], [{ id: 'op_1', status: 'interrupted' }]);
    settleRunningOperationMock.mockResolvedValue(settleResult('missing'));

    const result = await sweeper.sweep();

    expect(result).toMatchObject({ clearable: 1, failed: 0, settled: 0, skipped: 1 });
  });

  it('counts a topic a newer run claimed as skipped, not failed', async () => {
    const sweeper = buildSweeper([candidateRow()], [{ id: 'op_1', status: 'interrupted' }]);
    settleRunningOperationMock.mockResolvedValue(settleResult('conflict'));

    const result = await sweeper.sweep();

    expect(result).toMatchObject({ clearable: 1, failed: 0, settled: 0, skipped: 1 });
  });

  it('survives one poisoned row and keeps going', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    settleRunningOperationMock
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(settleResult('settled'));

    const sweeper = buildSweeper(
      [candidateRow({ id: 'tpc_1', operationId: 'op_1' }), candidateRow({ id: 'tpc_2', operationId: 'op_2' })],
      [
        { id: 'op_1', status: 'interrupted' },
        { id: 'op_2', status: 'interrupted' },
      ],
    );

    const result = await sweeper.sweep();

    expect(result).toMatchObject({ clearable: 2, examined: 2, failed: 1, settled: 1 });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  describe('dryRun', () => {
    it('reports what it would clear without writing', async () => {
      const sweeper = buildSweeper([candidateRow()], [{ id: 'op_1', status: 'interrupted' }]);

      const result = await sweeper.sweep({ dryRun: true });

      expect(result).toMatchObject({ clearable: 1, dryRun: true, settled: 0, skipped: 0 });
      expect(settleRunningOperationMock).not.toHaveBeenCalled();
    });
  });

  describe('bounds', () => {
    it('does nothing at all when no topic matches', async () => {
      const sweeper = buildSweeper([], []);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ examined: 0, settled: 0 });
      expect(topicModelConstructorMock).not.toHaveBeenCalled();
    });

    it('stops on the time budget instead of holding the tick open', async () => {
      const sweeper = buildSweeper(
        [candidateRow({ id: 'tpc_1', operationId: 'op_1' }), candidateRow({ id: 'tpc_2', operationId: 'op_2' })],
        [
          { id: 'op_1', status: 'interrupted' },
          { id: 'op_2', status: 'interrupted' },
        ],
      );

      const result = await sweeper.sweep({ maxDurationMs: -1 });

      // Nothing was claimed as clearable: the tick stopped before it proved
      // anything, and the next tick picks the same rows up again.
      expect(result).toMatchObject({ budgetExhausted: true, clearable: 0, settled: 0 });
      expect(settleRunningOperationMock).not.toHaveBeenCalled();
    });

    it('uses the same staleness window as the client watchdog', () => {
      // Cross-layer contract: the client's `cleanupStaleRunningTopics` must keep
      // believing a row this sweep would retire is still live (and vice versa),
      // or the two layers fight over the same topic.
      expect(DEFAULT_STALE_RUNNING_TOPIC_MS).toBe(2 * 60 * 60 * 1000);
    });
  });
});
