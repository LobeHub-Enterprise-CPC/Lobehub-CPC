// @vitest-environment node
import type { UIChatMessage } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelError } from '@/database/models/channel';
import type { ChannelRuntimeModel } from '@/database/models/channelRuntime';

import { ChannelRuntimeMessageStore } from './messageStore';

let rows: Array<UIChatMessage & { stableKey: string }>;
const model = {
  createMessage: vi.fn(async (data: UIChatMessage, stableKey: string) => {
    const existing = rows.find((row) => row.stableKey === stableKey);
    if (existing) return existing;
    rows.push({ ...data, stableKey });
    return data;
  }),
  deleteMessage: vi.fn(async (id: string) => {
    rows = rows.filter((row) => row.id !== id);
  }),
  messages: vi.fn(async () => rows.map(({ stableKey: _, ...row }) => row as UIChatMessage)),
  updateMessage: vi.fn(async (id: string, patch: (message: UIChatMessage) => UIChatMessage) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) throw new ChannelError('NOT_FOUND', 'Private runtime message not found');
    rows[index] = { ...patch(rows[index]), id, stableKey: rows[index].stableKey };
  }),
};
const store = new ChannelRuntimeMessageStore(model as unknown as ChannelRuntimeModel, 'owner');

beforeEach(() => {
  rows = [];
  vi.clearAllMocks();
});

describe('ChannelRuntimeMessageStore', () => {
  it('reuses the placeholder on a retried step through the runtime idempotency key', async () => {
    const first = await store.create({
      clientId: 'agent-runtime:op:step:0:instruction:0:assistant',
      content: '',
      role: 'assistant',
    });
    const second = await store.create({
      clientId: 'agent-runtime:op:step:0:instruction:0:assistant',
      content: '',
      role: 'assistant',
    });
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(first.id).toMatch(/^chn_private_/);
    expect(
      await store.findByClientId('agent-runtime:op:step:0:instruction:0:assistant'),
    ).toMatchObject({ id: first.id });
  });

  it('keys tool rows by parent and tool call id', async () => {
    const parent = await store.create({ content: '', role: 'assistant' });
    await store.create({
      content: 'pending',
      parentId: parent.id,
      plugin: { apiName: 'read', arguments: '{}', identifier: 'channel-artifact', type: 'builtin' },
      role: 'tool',
      tool_call_id: 'call_1',
    });
    await store.create({
      content: 'retry',
      parentId: parent.id,
      plugin: { apiName: 'read', arguments: '{}', identifier: 'channel-artifact', type: 'builtin' },
      role: 'tool',
      tool_call_id: 'call_1',
    });
    expect(rows.filter((row) => row.role === 'tool')).toHaveLength(1);
    const toolId = await store.findToolMessageIdByToolCallId('call_1', parent.id);
    expect(toolId).toBeDefined();
    expect(await store.findToolMessageIdByToolCallId('call_1', 'other-parent')).toBeUndefined();
    expect(await store.findMessagePlugin(toolId!)).toMatchObject({
      apiName: 'read',
      identifier: 'channel-artifact',
      toolCallId: 'call_1',
      type: 'builtin',
      userId: 'owner',
    });
    expect(await store.findMessagePlugin(parent.id)).toBeUndefined();
  });

  it('merges metadata on update and reports a missing row without throwing', async () => {
    const message = await store.create({
      content: '',
      metadata: { operationId: 'op' },
      role: 'assistant',
    });
    expect(
      await store.update(message.id, {
        content: 'done',
        metadata: { performance: { latency: 1 } },
      }),
    ).toEqual({ success: true });
    expect(await store.findById(message.id)).toMatchObject({
      content: 'done',
      metadata: { operationId: 'op', performance: { latency: 1 } },
    });
    expect(await store.update('missing', { content: 'x' })).toEqual({ success: false });
    expect(await store.findLatestAssistantByOperationId({ operationId: 'op' })).toMatchObject({
      id: message.id,
    });
  });

  it('replaces plugin columns wholesale like the messages model and throws when missing', async () => {
    const tool = await store.create({
      content: '',
      pluginState: { a: 1 },
      role: 'tool',
      tool_call_id: 'call',
    });
    await store.updateMessagePlugin(tool.id, { state: { b: 2 } });
    expect((await store.findById(tool.id))?.pluginState).toEqual({ b: 2 });
    await expect(store.updateMessagePlugin('missing', { state: {} })).rejects.toBeInstanceOf(
      ChannelError,
    );
  });

  it('merges tool state, and lets an ordered snapshot replace it wholesale', async () => {
    const tool = await store.create({
      content: '',
      pluginState: { a: 1 },
      role: 'tool',
      tool_call_id: 'call',
    });
    expect(await store.updateToolMessage(tool.id, { pluginState: { b: 2 } })).toEqual({
      applied: true,
      success: true,
    });
    expect((await store.findById(tool.id))?.pluginState).toEqual({ a: 1, b: 2 });
    const snapshot = (seq: number, state: Record<string, unknown>) =>
      store.updateToolMessage(tool.id, {
        heterogeneousToolState: { operationId: 'op', snapshotSeq: seq },
        pluginState: state,
      });
    expect(await snapshot(2, { c: 3 })).toEqual({ applied: true, success: true });
    expect((await store.findById(tool.id))?.pluginState).toEqual({ c: 3 });
    // A stale snapshot is acknowledged but not applied, like the messages table.
    expect(await snapshot(1, { stale: true })).toEqual({ applied: false, success: true });
    expect(await store.findById(tool.id)).toMatchObject({
      metadata: { heterogeneousToolStateOperationId: 'op', heterogeneousToolStateSeq: 2 },
      pluginState: { c: 3 },
    });
    expect(await store.updateToolMessage('missing', { content: 'x' })).toEqual({
      applied: false,
      success: false,
    });
  });
});
