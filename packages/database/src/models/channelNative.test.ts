// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { CHANNEL_LIMITS } from '@lobechat/types';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';

import * as schema from '../privateSchemas/channel';
import { messages } from '../schemas/message';
import { topics } from '../schemas/topic';
import type { LobeChatDatabase } from '../type';
import { ChannelModel } from './channel';
import { ChannelNativeModel } from './channelNative';

let client: PGlite;
let db: LobeChatDatabase;
let model: ChannelModel;
let run: any;
let store: ChannelNativeModel;
beforeEach(async () => {
  client = new PGlite();
  await client.exec(
    "create table users (id text primary key); insert into users values ('owner'), ('other');",
  );
  for (const name of ['0009_channel_mvp', '0010_channel_native_agent_runtime'])
    await client.exec(
      readFileSync(
        new URL(
          `../../../../../packages/enterprise/src/database/migrations/${name}.sql`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  // Standard topic columns, kept in sync with the real schema; unrelated foreign
  // keys are omitted because these bridge tests deliberately have no agent runtime.
  for (const table of [topics, messages])
    await client.exec(
      `CREATE TABLE ${getTableConfig(table).name} (${getTableConfig(table)
        .columns.map((c) => `"${c.name}" ${c.getSQLType()} ${c.name === 'id' ? 'PRIMARY KEY' : ''}`)
        .join(',')})`,
    );
  db = drizzle(client, { schema: { ...schema, topics } }) as unknown as LobeChatDatabase;
  model = new ChannelModel(db, 'owner');
  const config = { agentId: 'agent', runtime: 'native' as const, model: 'm', provider: 'p' };
  const channel = await model.create('Bridge', [
    { name: 'Native', config },
    { name: 'Reviewer', config: { ...config, agentId: 'reviewer' } },
  ]);
  const member = (await model.detail(channel.id)).members[0];
  await model.send(channel.id, { content: 'First', mentions: [member.id], requestKey: 'one' });
  const job = (await model.detail(channel.id)).jobs[0];
  run = (await model.claim(channel.id, job.id, member.environmentRevision))!.run;
  store = new ChannelNativeModel(db, 'owner', { runId: run.id, fence: run.executionFence });
});
afterEach(async () => {
  await client.close();
});
it('creates a real owned topic and one durable operation across retry/restart', async () => {
  const first = await store.prepare();
  const retry = await new ChannelNativeModel(db, 'owner', { runId: run.id, fence: 1 }).prepare();
  expect(first.fresh).toBe(true);
  expect(retry.fresh).toBe(false);
  expect(retry.operation.operationId).toBe(first.operation.operationId);
  const rows = await db.select().from(topics);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: first.operation.topicId,
    userId: 'owner',
    agentId: 'agent',
    workspaceId: null,
  });
  expect(first.operation.topicId).not.toBe(run.sessionId);
});
it('rejects foreign owners and stale execution fences', async () => {
  await expect(
    new ChannelNativeModel(db, 'other', { runId: run.id, fence: 1 }).prepare(),
  ).rejects.toThrow('authority');
  await expect(
    new ChannelNativeModel(db, 'owner', { runId: run.id, fence: 2 }).prepare(),
  ).rejects.toThrow('authority');
});
it('keeps the topic across incremental deliveries without importing input twice', async () => {
  const first = await store.prepare();
  await model.accepted(
    run.channelId,
    run.id,
    1,
    first.operation.topicId,
    first.operation.operationId,
  );
  await model.saveDraft(run.channelId, run.id, 1, 'First answer');
  await model.publish(run.channelId, run.id, 1);
  await model.releaseWriter(run.channelId, run.id, 1);
  await model.send(run.channelId, { content: 'Next', mentions: [run.memberId], requestKey: 'two' });
  const detail = await model.detail(run.channelId);
  const nextJob = detail.jobs.find((j) => j.status === 'queued')!;
  const next = (await model.claim(run.channelId, nextJob.id, 0))!.run;
  const second = await new ChannelNativeModel(db, 'owner', {
    runId: next.id,
    fence: next.executionFence,
  }).prepare();
  expect(second.operation.topicId).toBe(first.operation.topicId);
  expect(second.reconstruct).toBe(false);
  expect(next.manifest.messages.map((m) => m.id)).not.toContain(run.manifest.requestMessageId);
});
it('keeps an external call fenced after a crash and refuses to replay it', async () => {
  await store.prepare();
  await store.beginEffect('op', 'tool-one', 'tool');
  expect((await store.load()).effects[0].settled).toBe(false);
  await expect(store.beginEffect('op', 'tool-one', 'tool')).rejects.toThrow('refusing replay');
  await store.settleEffect('tool-one');
  expect((await store.load()).effects[0].settled).toBe(true);
});
it('enforces the persisted model-call budget across retries', async () => {
  await store.prepare();
  for (let i = 0; i < CHANNEL_LIMITS.modelCalls; i++)
    await store.beginEffect('op', `model-${i}`, 'model');
  await expect(store.beginEffect('op', 'extra', 'model')).rejects.toThrow('model call limit');
});
it('revocation blocks new calls but allows a real completion receipt', async () => {
  await store.prepare();
  await store.beginEffect('op', 'started', 'tool');
  await model.stop(run.channelId, { runId: run.id });
  await expect(store.beginEffect('op', 'late', 'tool')).rejects.toThrow('revoked');
  await store.settleEffect('started');
  expect((await store.load()).effects[0].settled).toBe(true);
});
it('ignores late receipts from an older approval segment and never selects an earlier answer', async () => {
  const prepared = await store.prepare();
  await store.ready({
    operationId: prepared.operation.operationId,
    topicId: prepared.operation.topicId,
    assistantMessageId: 'assistant',
    stepIndex: 0,
  });
  await store.ready({
    operationId: 'continuation',
    topicId: prepared.operation.topicId,
    assistantMessageId: 'new-assistant',
    stepIndex: 0,
  });
  await store.observe(prepared.operation.operationId, {
    status: 'done',
    messages: [{ id: 'assistant', role: 'assistant', content: 'stale' }],
  } as any);
  expect((await store.load()).checkpoint?.receipt).toBeUndefined();
  await store.observe('continuation', {
    status: 'done',
    messages: [{ id: 'assistant', role: 'assistant', content: 'stale' }],
  } as any);
  expect((await store.load()).checkpoint?.receipt).not.toHaveProperty('content');
});

it('reads the final operation-owned answer after compression removed the initial anchor', async () => {
  const { operation } = await store.prepare();
  await store.ready({ operationId: operation.operationId, topicId: operation.topicId, assistantMessageId: 'initial-assistant', stepIndex: 0 });
  await db
    .insert(messages)
    .values({
      id: 'final-assistant',
      userId: 'owner',
      topicId: operation.topicId,
      role: 'assistant',
      content: 'Final after compression',
      metadata: { operationId: operation.operationId },
    });
  await store.observe(operation.operationId, {
    status: 'done',
    metadata: { workAssistantMessageId: 'final-assistant' },
    messages: [{ role: 'system', content: 'compressed history' }],
  } as any);
  expect((await store.load()).checkpoint?.receipt).toMatchObject({
    content: 'Final after compression',
  });
  await db.update(messages).set({ metadata: { operationId: 'previous-operation' } });
  await store.observe(operation.operationId, {
    status: 'done',
    metadata: { workAssistantMessageId: 'final-assistant' },
  } as any);
  expect((await store.load()).checkpoint?.receipt).not.toHaveProperty('content');
});
it('persists approval intent through interruption and clears it when the continuation is ready', async () => {
  const { operation } = await store.prepare();
  await store.ready({ operationId: operation.operationId, topicId: operation.topicId, stepIndex: 0 });
  await store.prepareApproval(operation.operationId, {
    pendingToolsCalling: [{ id: 'tool' } as any],
    pendingToolMessageIds: { tool: 'message' },
  });
  await store.observe(operation.operationId, { status: 'interrupted' } as any);
  expect((await store.load()).checkpoint?.approvalIntent).toMatchObject({
    operationId: operation.operationId,
  });
  await store.ready({ operationId: 'continuation', topicId: operation.topicId, stepIndex: 0 });
  expect((await store.load()).checkpoint?.approvalIntent).toBeNull();
});
