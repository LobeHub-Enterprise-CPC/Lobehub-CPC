// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agentOperations, users } from '../../schemas';
import { AgentOperationModel } from '../agentOperation';

const db = await getTestDB();
const userId = 'async-resume-lease-owner';
const model = new AgentOperationModel(db, userId);
const now = new Date('2026-10-30T12:00:00.000Z');
const until = new Date('2026-10-30T12:01:00.000Z');

beforeEach(async () => {
  await db.insert(users).values([{ id: userId }, { id: 'async-resume-other' }]);
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
        operationId: 'resume-operation',
        metadata: {
          preserved: 'value',
          asyncToolResumeIntent: { state: 'pending', deduplicationId: 'previous', leaseUntil },
        },
      });
      expect(
        await new AgentOperationModel(db, 'async-resume-other').claimAsyncToolResume(
          'resume-operation',
          'previous',
          'next',
          'worker',
          now,
          until,
        ),
      ).toBe(false);
      expect(
        await model.claimAsyncToolResume('resume-operation', 'wrong', 'next', 'worker', now, until),
      ).toBe(false);
      expect(
        await model.claimAsyncToolResume(
          'resume-operation',
          'previous',
          'next',
          'worker',
          now,
          until,
        ),
      ).toBe(expected);
      const row = await model.findById('resume-operation');
      expect(row?.metadata?.preserved).toBe('value');
      expect(row?.metadata?.asyncToolResumeIntent).toMatchObject({
        state: 'pending',
        deduplicationId: expected ? 'next' : 'previous',
        ...(expected && { leaseOwner: 'worker', leaseUntil: until.toISOString() }),
      });
      expect(
        await model.claimAsyncToolResume(
          'resume-operation',
          'previous',
          'other',
          'worker-2',
          now,
          until,
        ),
      ).toBe(false);
    },
  );
});
