import type { SerializedAgentHook } from '@lobechat/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pendingPublishCount, settlePendingPublishes } from '@/server/modules/Hatchet/pending';

import { HookDispatcher } from '../HookDispatcher';
import { deliverWebhook } from '../httpWebhook';
import type { AgentHookEvent } from '../types';

const { getEmailsByIds } = vi.hoisted(() => ({ getEmailsByIds: vi.fn() }));

// Queue mode: hooks are delivered from their serialized webhook configs.
vi.mock('@/server/services/queue/impls', () => ({ isQueueAgentRuntimeEnabled: () => true }));
vi.mock('../httpWebhook', () => ({
  deliverWebhook: vi.fn(async () => {}),
  executeToolCallWebhook: vi.fn(),
}));
vi.mock('@/database/models/user', () => ({ UserModel: { getEmailsByIds } }));
vi.mock('@/database/server', () => ({ getServerDB: async () => ({}) }));

const operationId = 'op_drain';
const webhook = { delivery: 'qstash' as const, url: 'https://example.com/hook' };
const event: AgentHookEvent = { agentId: 'agt_test', operationId, userId: 'user_1' };

/** The payload waits for the user's email; the returned function lets the lookup answer. */
const holdEmailLookup = () => {
  let answer!: () => void;
  getEmailsByIds.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = () => resolve([{ email: 'user@example.com', id: 'user_1' }]);
      }),
  );
  return () => answer();
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('HookDispatcher pending publishes', () => {
  afterEach(async () => {
    await settlePendingPublishes();
    vi.clearAllMocks();
  });

  it('counts a fire-and-forget dispatch as pending while its payload is still being built', async () => {
    const answer = holdEmailLookup();
    const hooks: SerializedAgentHook[] = [{ id: 'observer', type: 'afterToolCall', webhook }];

    void new HookDispatcher().dispatch(operationId, 'afterToolCall', event, hooks);
    expect(pendingPublishCount()).toBe(1);

    let settled = false;
    const settling = settlePendingPublishes().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(deliverWebhook).not.toHaveBeenCalled();

    answer();
    await settling;
    expect(deliverWebhook).toHaveBeenCalledTimes(1);
    expect(pendingPublishCount()).toBe(0);
  });

  it('counts the beforeToolCall observation that the tool does not wait for', async () => {
    const answer = holdEmailLookup();
    const hooks: SerializedAgentHook[] = [{ id: 'observer', type: 'beforeToolCall', webhook }];

    await new HookDispatcher().dispatchBeforeToolCall(
      operationId,
      { ...event, apiName: 'run', identifier: 'tool', toolCallId: 'call_1' } as never,
      hooks,
    );
    expect(pendingPublishCount()).toBe(1);

    answer();
    await settlePendingPublishes();
    expect(deliverWebhook).toHaveBeenCalledTimes(1);
    expect(pendingPublishCount()).toBe(0);
  });
});
