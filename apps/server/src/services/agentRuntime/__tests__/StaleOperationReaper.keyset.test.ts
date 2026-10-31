// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { type LobeChatDatabase } from '@lobechat/database';
import { agentOperations, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaleOperationReaper } from '../StaleOperationReaper';

/** In-memory stand-in for the tenant's agent runtime Redis (TTL ignored). */
const redis = vi.hoisted(() => {
  const keys = new Map<string, string>();
  return {
    del: vi.fn(async (key: string) => Number(keys.delete(key))),
    get: vi.fn(async (key: string) => keys.get(key) ?? null),
    keys,
    set: vi.fn(async (key: string, value: string) => {
      keys.set(key, value);
      return 'OK';
    }),
  };
});
vi.mock('@/server/services/redis/client', () => ({
  getRedisServiceClient: async () => redis,
}));

/**
 * The fair scan pages by `(updated_at, id)`, within a sweep and across sweeps.
 * Against a real database because the cursor has to survive what only Postgres
 * does: microsecond timestamps (a JS Date keeps milliseconds), ties on
 * `updated_at`, and the round trip of the cursor through `timestamptz::text`.
 */
describe('StaleOperationReaper keyset paging', () => {
  let serverDB: LobeChatDatabase;
  let userId: string;

  // [id, microseconds after base]: the first five share one millisecond, and
  // four of them one microsecond, inserted against `id` order so that only the
  // `id` tiebreak orders them.
  const seeds: [string, number][] = [
    ['op_tie_d', 100],
    ['op_tie_c', 100],
    ['op_tie_b', 100],
    ['op_tie_a', 100],
    ['op_same_ms', 900],
    ['op_next_ms', 1000],
    ['op_mid', 1500],
    ['op_late', 1_000_000],
    ['op_last', 2_000_000],
  ];
  const oldestFirst = [
    'op_tie_a',
    'op_tie_b',
    'op_tie_c',
    'op_tie_d',
    'op_same_ms',
    'op_next_ms',
    'op_mid',
    'op_late',
    'op_last',
  ];

  beforeEach(async () => {
    serverDB = await getTestDB();
    userId = randomUUID();
    redis.keys.clear();
    await serverDB.insert(users).values({ id: userId });

    // One hour ago on a whole second, so all of them are past the lease.
    const base = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000).toISOString();
    for (const [id, micros] of seeds) {
      await serverDB.insert(agentOperations).values({ id, status: 'running', userId });
      await serverDB.execute(
        sql`update agent_operations set updated_at = ${base}::timestamptz + ${`${micros} microseconds`}::interval where id = ${id}`,
      );
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    await serverDB.delete(agentOperations).where(eq(agentOperations.userId, userId));
    await serverDB.delete(users).where(eq(users.id, userId));
  });

  /** Every candidate is still queued in Hatchet; `stepMs` is how long each probe takes. */
  const buildReaper = (visited: string[], stepMs = 0) =>
    new StaleOperationReaper(serverDB, {
      coordinator: {
        getExecutionHistory: vi.fn(async () => [
          { context: { phase: 'llm_result' }, stepIndex: 0 },
        ]),
        isInterrupted: vi.fn(async () => false),
        loadAgentState: vi.fn(async () => ({ metadata: {}, status: 'running', stepCount: 1 })),
        loadInlineResume: vi.fn(async () => null),
        touchOperation: vi.fn(async () => {}),
      } as any,
      deliveryProbe: async (operationId) => {
        visited.push(operationId);
        if (stepMs) vi.setSystemTime(Date.now() + stepMs);
        return 'active';
      },
      queueService: { scheduleMessage: vi.fn() } as any,
    });

  it('visits every stale candidate once, oldest first, across pages', async () => {
    const visited: string[] = [];

    const result = await buildReaper(visited).sweep({ limit: 2 });

    expect(visited).toEqual(oldestFirst);
    expect(result).toMatchObject({ examined: 9, redriven: 0, skipped: 9 });
  });

  it('continues where the time budget stopped the previous sweep, then wraps around', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 6s per candidate against the 20s budget: four candidates per sweep.
    const sweeps: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const visited: string[] = [];
      await buildReaper(visited, 6_000).sweep({ limit: 2 });
      sweeps.push(visited);
    }

    expect(sweeps).toEqual([
      oldestFirst.slice(0, 4),
      oldestFirst.slice(4, 8),
      oldestFirst.slice(8),
      // The third reached the newest candidate, so the fourth starts over.
      oldestFirst.slice(0, 4),
    ]);
  });

  /** `updated_at` exactly as the reaper stores it in its cursor. */
  const storedUpdatedAt = async (id: string) => {
    const [row] = await serverDB
      .select({ updatedAt: sql<string>`${agentOperations.updatedAt}::text` })
      .from(agentOperations)
      .where(eq(agentOperations.id, id));
    return row.updatedAt;
  };

  it.each([
    // A position that is otherwise usable: resuming from it would skip the oldest.
    [
      'it has no cycle start',
      async () => ({ id: 'op_mid', updatedAt: await storedUpdatedAt('op_mid') }),
    ],
    // A valid cycle start, so only the timestamp check keeps this value away
    // from the cursor's `::timestamptz` cast.
    [
      'its timestamp is malformed',
      async () => ({ cycleStart: Date.now(), id: 'op_mid', updatedAt: 'not-a-time' }),
    ],
  ])('starts from the oldest when the stored cursor is not usable: %s', async (_label, stored) => {
    redis.keys.set('stale_sweep_cursor:v1', JSON.stringify(await stored()));
    const visited: string[] = [];

    await buildReaper(visited).sweep({ limit: 2 });

    expect(visited).toEqual(oldestFirst);
  });
});
