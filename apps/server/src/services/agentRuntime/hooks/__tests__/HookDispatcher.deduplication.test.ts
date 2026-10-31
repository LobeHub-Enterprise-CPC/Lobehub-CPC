import type { SerializedAgentHook } from '@lobechat/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

import { HookDispatcher } from '../HookDispatcher';
import { deliverWebhook } from '../httpWebhook';
import type { AgentHookEvent } from '../types';

const hatchet = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => hatchet.enabled,
}));
// Queue mode: hooks are delivered from their serialized webhook configs.
vi.mock('@/server/services/queue/impls', () => ({ isQueueAgentRuntimeEnabled: () => true }));
vi.mock('../httpWebhook', () => ({
  deliverWebhook: vi.fn(async () => {}),
  executeToolCallWebhook: vi.fn(),
}));
vi.mock('@/database/models/user', () => ({ UserModel: { getEmailsByIds: async () => [] } }));
vi.mock('@/database/server', () => ({ getServerDB: async () => ({}) }));

const operationId = 'op_dedup';
const webhook = {
  delivery: 'qstash' as const,
  fallback: 'none' as const,
  url: 'https://example.com/hook',
};
const hooks: SerializedAgentHook[] = [
  { id: 'bot-reply', type: 'onComplete', webhook },
  { id: 'bot-error', type: 'onError', webhook },
  { id: 'progress', type: 'afterStep', webhook },
];
const event = (overrides?: Partial<AgentHookEvent>): AgentHookEvent => ({
  agentId: 'agt_test',
  operationId,
  reason: 'error',
  status: 'error',
  userId: 'user_test',
  ...overrides,
});
const deliveryOptions = () => vi.mocked(deliverWebhook).mock.calls.map((call) => call[2]);

afterEach(() => {
  hatchet.enabled = true;
  vi.mocked(deliverWebhook).mockClear();
});

describe('HookDispatcher completion webhook deduplication', () => {
  it('keys onComplete and onError by operation, hook, type and reason, the same on a replay', async () => {
    const dispatcher = new HookDispatcher();

    await dispatcher.dispatch(operationId, 'onComplete', event(), hooks);
    await dispatcher.dispatch(operationId, 'onError', event(), hooks);
    await dispatcher.dispatch(operationId, 'onComplete', event(), hooks);
    await dispatcher.dispatch(operationId, 'onComplete', event({ reason: undefined }), hooks);

    expect(deliveryOptions()).toEqual([
      { deduplicationId: 'op_dedup:bot-reply:onComplete:error' },
      { deduplicationId: 'op_dedup:bot-error:onError:error' },
      { deduplicationId: 'op_dedup:bot-reply:onComplete:error' },
      { deduplicationId: 'op_dedup:bot-reply:onComplete:' },
    ]);
  });

  it('leaves the other hook types without a key', async () => {
    await new HookDispatcher().dispatch(operationId, 'afterStep', event({ stepIndex: 2 }), hooks);

    expect(deliverWebhook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverWebhook).mock.calls[0]).toHaveLength(2);
  });

  it('adds no key outside Hatchet', async () => {
    hatchet.enabled = false;

    await new HookDispatcher().dispatch(operationId, 'onComplete', event(), hooks);

    expect(deliverWebhook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverWebhook).mock.calls[0]).toHaveLength(2);
  });
});
