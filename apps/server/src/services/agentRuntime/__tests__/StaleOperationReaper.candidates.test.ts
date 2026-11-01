// @vitest-environment node
import type { AgentState } from '@lobechat/agent-runtime';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { agentOperations } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime/AgentRuntimeCoordinator';
import type { QueueService } from '@/server/services/queue';

import { StaleOperationReaper } from '../StaleOperationReaper';

const NOW = new Date('2026-11-01T00:00:00.000Z').getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const userId = 'reaper-candidate-test-user';

describe('StaleOperationReaper candidate window (real database)', () => {
  let db: LobeChatDatabase;

  beforeEach(async () => {
    db = await getTestDB();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.delete(agentOperations).where(eq(agentOperations.userId, userId));
  });

  const row = (
    id: string,
    ageMs: number,
    extra: Partial<typeof agentOperations.$inferInsert> = {},
  ) => ({
    id,
    startedAt: new Date(NOW - ageMs),
    status: 'running' as const,
    updatedAt: new Date(NOW - ageMs),
    userId,
    ...extra,
  });

  const buildReaper = (resumableIds: string[] = []) => {
    const loadAgentState = vi.fn(async (id: string) =>
      resumableIds.includes(id)
        ? ({
            initialContext: { phase: 'user_input' },
            metadata: {},
            status: 'idle',
            stepCount: 0,
          } as unknown as AgentState)
        : null,
    );
    const queue = { scheduleMessage: vi.fn().mockResolvedValue('delivery') };
    const reaper = new StaleOperationReaper(db, {
      coordinator: { loadAgentState } as unknown as AgentRuntimeCoordinator,
      queueService: queue as unknown as QueueService,
    });
    return { loadAgentState, queue, reaper };
  };

  it('redrives a recent stale operation despite more than 50 unrecoverable historical rows', async () => {
    await db
      .insert(agentOperations)
      .values([
        ...Array.from({ length: 60 }, (_, index) => row(`historic-${index}`, 2 * DAY + index)),
        row('recent-dead', 10 * MINUTE),
      ]);
    const { loadAgentState, queue, reaper } = buildReaper(['recent-dead']);

    const result = await reaper.sweep();

    expect(result).toMatchObject({ examined: 1, failed: 0, redriven: 1, skipped: 0 });
    expect(loadAgentState.mock.calls.map(([id]) => id)).toEqual(['recent-dead']);
    expect(queue.scheduleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'recent-dead', stepIndex: 0 }),
    );
    const historicRows = await db
      .select({ status: agentOperations.status })
      .from(agentOperations)
      .where(eq(agentOperations.id, 'historic-0'));
    expect(historicRows).toEqual([{ status: 'running' }]);
  });

  it('includes the lookback boundary and preserves the stale, status and initial-lease guards', async () => {
    await db
      .insert(agentOperations)
      .values([
        row('before-floor', DAY + 1),
        row('at-floor', DAY),
        row('within-window', 10 * MINUTE),
        row('never-heartbeated', 6 * MINUTE, { startedAt: null }),
        row('at-stale-boundary', 5 * MINUTE),
        row('fresh-heartbeat', MINUTE),
        row('fresh-start', 10 * MINUTE, { startedAt: new Date(NOW - MINUTE) }),
        row('done', 10 * MINUTE, { status: 'done' }),
      ]);
    const { loadAgentState, reaper } = buildReaper();

    const result = await reaper.sweep();

    expect(result).toMatchObject({ examined: 3, failed: 0, skipped: 3 });
    expect(loadAgentState.mock.calls.map(([id]) => id)).toEqual([
      'at-floor',
      'within-window',
      'never-heartbeated',
    ]);
  });

  it('keeps oldest-first ordering and the requested limit inside the window', async () => {
    await db
      .insert(agentOperations)
      .values([row('newer', 10 * MINUTE), row('oldest', 20 * MINUTE), row('middle', 15 * MINUTE)]);
    const { loadAgentState, reaper } = buildReaper();

    const result = await reaper.sweep({ limit: 2 });

    expect(result).toMatchObject({ examined: 2, skipped: 2 });
    expect(loadAgentState.mock.calls.map(([id]) => id)).toEqual(['oldest', 'middle']);
  });

  it('uses the requested lookback window', async () => {
    await db
      .insert(agentOperations)
      .values([
        row('outside-custom-window', 2 * 60 * MINUTE),
        row('at-custom-floor', 60 * MINUTE),
        row('inside-custom-window', 10 * MINUTE),
      ]);
    const { loadAgentState, reaper } = buildReaper();

    const result = await reaper.sweep({ lookbackMs: 60 * MINUTE });

    expect(result).toMatchObject({ examined: 2, skipped: 2 });
    expect(loadAgentState.mock.calls.map(([id]) => id)).toEqual([
      'at-custom-floor',
      'inside-custom-window',
    ]);
  });
});
