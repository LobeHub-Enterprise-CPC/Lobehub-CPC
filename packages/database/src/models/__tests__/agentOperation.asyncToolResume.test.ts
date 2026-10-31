// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agentOperations, users } from '../../schemas';
import { AgentOperationModel, listPendingAsyncToolResumes } from '../agentOperation';

const db = await getTestDB();
const userId = 'async-resume-lease-owner';
const otherUserId = 'async-resume-other';
const model = new AgentOperationModel(db, userId);
const now = new Date('2026-10-30T12:00:00.000Z');
const until = new Date('2026-10-30T12:01:00.000Z');
const operationId = 'resume-operation';
const intentOf = async () =>
  (await model.findById(operationId))?.metadata?.asyncToolResumeIntent as
    Record<string, unknown> | undefined;

beforeEach(async () => {
  await db.insert(users).values([{ id: userId }, { id: otherUserId }]);
});
afterEach(async () => {
  await db.delete(agentOperations);
  await db.delete(users);
});

describe('async tool resume lease', () => {
  it.each([
    ['missing', undefined, true],
    ['JSON null', null, true],
    ['expired', '2026-10-30T11:59:00.000Z', true],
    ['expires now', now.toISOString(), true],
    ['live', '2026-10-30T12:00:01.000Z', false],
  ] as const)(
    'claims a %s lease without bypassing the continuation CAS',
    async (_label, leaseUntil, expected) => {
      await model.recordStart({
        operationId,
        metadata: {
          preserved: 'value',
          asyncToolResumeIntent: { state: 'pending', deduplicationId: 'previous', leaseUntil },
        },
      });
      expect(
        await new AgentOperationModel(db, otherUserId).claimAsyncToolResume(
          operationId,
          'previous',
          'next',
          'worker',
          now,
          until,
          3,
        ),
      ).toBe(false);
      expect(
        await model.claimAsyncToolResume(operationId, 'wrong', 'next', 'worker', now, until, 3),
      ).toBe(false);
      expect(
        await model.claimAsyncToolResume(operationId, 'previous', 'next', 'worker', now, until, 3),
      ).toBe(expected);
      const row = await model.findById(operationId);
      expect(row?.metadata?.preserved).toBe('value');
      expect(row?.metadata?.asyncToolResumeIntent).toMatchObject({
        state: 'pending',
        deduplicationId: expected ? 'next' : 'previous',
        ...(expected && { leaseOwner: 'worker', leaseUntil: until.toISOString() }),
      });
      expect(
        await model.claimAsyncToolResume(
          operationId,
          'previous',
          'other',
          'worker-2',
          now,
          until,
          3,
        ),
      ).toBe(false);
    },
  );

  it('releases only its own lease, so the next sweep can claim at once', async () => {
    await model.recordStart({
      operationId,
      metadata: { asyncToolResumeIntent: { state: 'pending', deduplicationId: 'key' } },
    });
    expect(
      await model.claimAsyncToolResume(operationId, 'key', 'next', 'worker', now, until, 3),
    ).toBe(true);

    expect(await model.releaseAsyncToolResume(operationId, 'other-worker')).toBe(false);
    expect(await model.releaseAsyncToolResume(operationId, 'worker')).toBe(true);

    const intent = await intentOf();
    expect(intent).toMatchObject({ deduplicationId: 'next', state: 'pending' });
    expect(intent).not.toHaveProperty('leaseOwner');
    expect(intent).not.toHaveProperty('leaseUntil');
    expect(
      await model.claimAsyncToolResume(operationId, 'next', 'again', 'worker-2', now, until, 3),
    ).toBe(true);
  });

  it('counts each claimed re-publish and refuses one past the budget', async () => {
    await model.recordStart({
      operationId,
      metadata: { asyncToolResumeIntent: { state: 'pending', deduplicationId: 'key-0' } },
    });
    for (const attempt of [1, 2]) {
      const owner = `worker-${attempt}`;
      expect(
        await model.claimAsyncToolResume(
          operationId,
          `key-${attempt - 1}`,
          `key-${attempt}`,
          owner,
          now,
          until,
          2,
        ),
      ).toBe(true);
      expect(await intentOf()).toMatchObject({
        attempts: attempt,
        deduplicationId: `key-${attempt}`,
      });
      expect(await model.releaseAsyncToolResume(operationId, owner)).toBe(true);
    }

    expect(
      await model.claimAsyncToolResume(operationId, 'key-2', 'key-3', 'worker-3', now, until, 2),
    ).toBe(false);
    expect(await intentOf()).toMatchObject({ attempts: 2, deduplicationId: 'key-2' });
  });
});

describe('async tool resume bookkeeping', () => {
  const lease = new Date('2026-01-01T00:00:00.000Z');
  const later = new Date('2026-10-30T12:02:00.000Z');

  it.each([
    [
      'scan',
      () => model.noteAsyncToolResumeScan(operationId, 'key', now),
      (intent?: Record<string, unknown>) =>
        expect(intent).toMatchObject({ lastScannedAt: now.toISOString() }),
    ],
    [
      'renewal',
      () => model.renewAsyncToolResume(operationId, 'worker', now, later),
      (intent?: Record<string, unknown>) =>
        expect(intent).toMatchObject({ leaseUntil: later.toISOString() }),
    ],
    [
      'release',
      () => model.releaseAsyncToolResume(operationId, 'worker'),
      (intent?: Record<string, unknown>) => expect(intent).not.toHaveProperty('leaseOwner'),
    ],
    [
      'confirmation',
      () => model.confirmAsyncToolResume(operationId, 'key'),
      (intent?: Record<string, unknown>) => expect(intent).toMatchObject({ state: 'confirmed' }),
    ],
  ])('records a %s without re-arming the liveness lease', async (_label, write, applied) => {
    await model.recordStart({
      operationId,
      metadata: {
        asyncToolResumeIntent: {
          createdAt: '2026-10-30T11:00:00.000Z',
          deduplicationId: 'key',
          leaseOwner: 'worker',
          leaseUntil: until.toISOString(),
          state: 'pending',
        },
      },
    });
    await db
      .update(agentOperations)
      .set({ updatedAt: lease })
      .where(eq(agentOperations.id, operationId));

    await write();

    const row = await model.findById(operationId);
    applied(row?.metadata?.asyncToolResumeIntent as Record<string, unknown> | undefined);
    expect(row?.updatedAt).toEqual(lease);
  });
});

describe('listPendingAsyncToolResumes', () => {
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
  const graceBefore = new Date(now.getTime() - 60_000);
  const pending = (createdAt: string, lastScannedAt?: string) => ({
    asyncToolResumeIntent: {
      createdAt,
      deduplicationId: 'key',
      ...(lastScannedAt && { lastScannedAt }),
      payload: { resumeAsyncTool: true },
      state: 'pending',
      stepIndex: 2,
      waitingToolCallIds: ['tool'],
    },
  });
  /** Least recently scanned first; equal scan times fall back to the id. */
  const expectedOrder = ['op-other-user', 'op-a', 'op-b', 'op-rescanned', 'op-at-grace'];

  beforeEach(async () => {
    await db.insert(agentOperations).values([
      // Inserted against `id` order: only the id tiebreak orders these two.
      { id: 'op-b', metadata: pending(at(-600_000)), status: 'running', userId },
      { id: 'op-a', metadata: pending(at(-600_000)), status: 'running', userId },
      // Oldest intent, but examined five minutes ago: behind the unexamined ones.
      {
        id: 'op-rescanned',
        metadata: pending(at(-1_200_000), at(-300_000)),
        status: 'running',
        userId,
      },
      {
        id: 'op-other-user',
        metadata: pending(at(-900_000)),
        status: 'running',
        userId: otherUserId,
      },
      // Exactly at the grace boundary still counts.
      {
        id: 'op-at-grace',
        metadata: pending(graceBefore.toISOString()),
        status: 'running',
        userId,
      },
      // Not candidates: inside the grace, already examined by this sweep,
      // confirmed, parked, or carrying no intent at all.
      { id: 'op-fresh', metadata: pending(at(-30_000)), status: 'running', userId },
      {
        id: 'op-scanned-now',
        metadata: pending(at(-1_800_000), now.toISOString()),
        status: 'running',
        userId,
      },
      {
        id: 'op-confirmed',
        metadata: {
          asyncToolResumeIntent: {
            ...pending(at(-1_800_000)).asyncToolResumeIntent,
            state: 'confirmed',
          },
        },
        status: 'running',
        userId,
      },
      {
        id: 'op-parked',
        metadata: pending(at(-1_800_000)),
        status: 'waiting_for_async_tool',
        userId,
      },
      { id: 'op-no-intent', metadata: {}, status: 'running', userId },
    ]);
  });

  it('lists pending intents of running operations of every user past the grace', async () => {
    const rows = await listPendingAsyncToolResumes(db, graceBefore, now, 10);

    expect(rows.map((row) => row.id)).toEqual(expectedOrder);
    expect(rows[0]).toMatchObject({
      intent: { deduplicationId: 'key', state: 'pending', stepIndex: 2 },
      scannedAt: at(-900_000),
      userId: otherUserId,
      workspaceId: null,
    });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === 'op-rescanned')?.scannedAt).toBe(at(-300_000));
  });

  it('pages by (scannedAt, id) without repeating or skipping equal scan times', async () => {
    const visited: string[] = [];
    let cursor: { id: string; scannedAt: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await listPendingAsyncToolResumes(db, graceBefore, now, 2, cursor);
      if (!rows.length) break;
      visited.push(...rows.map((row) => row.id));
      cursor = { id: rows.at(-1)!.id, scannedAt: rows.at(-1)!.scannedAt };
    }

    expect(visited).toEqual(expectedOrder);
  });

  it('is not reachable through the user-scoped model', () => {
    expect('listPendingAsyncToolResumes' in AgentOperationModel.prototype).toBe(false);
  });
});
