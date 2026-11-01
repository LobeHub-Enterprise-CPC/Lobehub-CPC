// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agentSubAgentBridges } from '../../privateSchemas';
import { AgentSubAgentBridgeModel } from '../agentSubAgentBridge';

const db = await getTestDB();
const model = new AgentSubAgentBridgeModel(db);
const binding = (childOperationId: string) => ({
  childOperationId,
  childRunToken: `run-${childOperationId}`,
  parentOperationId: 'parent',
  threadId: 'thread',
  toolMessageId: `tool-${childOperationId}`,
  userId: 'user',
  waitingBatchId: `tool-${childOperationId}`,
});

afterEach(async () => {
  await db.delete(agentSubAgentBridges);
});

describe('AgentSubAgentBridgeModel', () => {
  it('creates idempotently without changing the original identity', async () => {
    await model.create(binding('child'));
    await model.create(binding('child'));
    await expect(model.create({ ...binding('child'), toolMessageId: 'different' })).rejects.toThrow(
      'identity conflict',
    );
    const rows = await db.select().from(agentSubAgentBridges);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', toolMessageId: 'tool-child', attempts: 0 });
  });

  it('lists only aged pending records in stable pages', async () => {
    await model.create(binding('a'));
    await model.create(binding('b'));
    await model.create(binding('c'));
    await model.markDelivered('c');
    expect(await model.listRecoverable({ before: new Date(0), limit: 10, offset: 0 })).toHaveLength(
      0,
    );
    const before = new Date(Date.now() + 1000);
    const first = await model.listRecoverable({ before, limit: 1, offset: 0 });
    const second = await model.listRecoverable({ before, limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].childOperationId).not.toBe(second[0].childOperationId);
  });

  it('claims only once until the lease expires and counts attempts', async () => {
    await model.create(binding('child'));
    const now = new Date();
    const until = new Date(now.getTime() + 1000);
    expect(await model.claim('child', 'worker-a', now, until)).toBe(true);
    expect(await model.claim('child', 'worker-b', now, until)).toBe(false);
    expect(
      await model.claim(
        'child',
        'worker-b',
        new Date(until.getTime() + 1),
        new Date(until.getTime() + 2000),
      ),
    ).toBe(true);
    const [row] = await db.select().from(agentSubAgentBridges);
    expect(row).toMatchObject({ attempts: 2, leaseOwner: 'worker-b' });
  });

  it('requires the lease owner to settle recovery and never reclaims delivered records', async () => {
    await model.create(binding('a'));
    await model.create(binding('b'));
    const now = new Date();
    await model.claim('a', 'worker', now, new Date(now.getTime() + 1000));
    expect(await model.markRecovered('a', 'other', now)).toBe(false);
    expect(await model.markRecovered('a', 'worker', now)).toBe(true);
    await model.markDelivered('b', {
      parentOperationId: 'parent',
      threadId: 'thread',
      toolMessageId: 'tool-b',
      userId: 'user',
      completionReason: 'done',
    });
    const delivered = (await db.select().from(agentSubAgentBridges)).find(
      (row) => row.childOperationId === 'b',
    );
    expect(delivered?.completionReason).toBe('done');
    expect(await model.claim('b', 'worker', now, new Date(now.getTime() + 1000))).toBe(false);
    expect((await db.select().from(agentSubAgentBridges)).map((r) => r.status).sort()).toEqual([
      'delivered',
      'recovered',
    ]);
  });

  it('records a bounded error code only for a valid lease', async () => {
    await model.create(binding('child'));
    const now = new Date();
    await model.claim('child', 'worker', now, new Date(now.getTime() + 1000));
    expect(await model.markFailed('child', 'other', now, 'state_missing')).toBe(false);
    expect(await model.markFailed('child', 'worker', now, 'state_missing')).toBe(true);
    const [row] = await db.select().from(agentSubAgentBridges);
    expect(row).toMatchObject({ status: 'failed', lastError: 'state_missing', leaseOwner: null });
  });
});
