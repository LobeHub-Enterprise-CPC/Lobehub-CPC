import '@/server/test-utils/serverTestConfig';

import type { ChatToolPayload } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGatewayAttempt } from '@/server/services/gatewayAuthorization/attempts';
import { waitForGatewayResult } from '@/server/services/gatewayAuthorization/waiter';

import { dispatchClientTool } from '../dispatchClientTool';
import { GLOBAL_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../resolveToolTimeout';
import type { IStreamEventManager } from '../types';

vi.mock('@/server/services/gatewayAuthorization/attempts', () => ({
  createGatewayAttempt: vi.fn(),
}));
vi.mock('@/server/services/gatewayAuthorization/context', () => ({
  operationGatewaySource: (subject: string, operationId: string) => ({
    kind: 'operation',
    subject,
    operationId,
  }),
}));
vi.mock('@/server/services/gatewayAuthorization/operationAuthority', () => ({
  operationExecutionContext: async () => ({ tenantId: 'test-tenant', sourceAcceptedVersion: 1 }),
  loadGatewayOperation: async () => ({ userId: 'test-user' }),
}));
vi.mock('@/server/services/gatewayAuthorization/waiter', () => ({ waitForGatewayResult: vi.fn() }));

function makePayload(overrides: Partial<ChatToolPayload> = {}): ChatToolPayload {
  return {
    apiName: 'readFile',
    arguments: '{"path":"/tmp/x"}',
    executor: 'client',
    id: 'call-1',
    identifier: 'local-system',
    type: 'default' as any,
    ...overrides,
  };
}

function makeStreamManager(
  sendToolExecute?: IStreamEventManager['sendToolExecute'],
): IStreamEventManager {
  return {
    cleanupOperation: vi.fn(),
    disconnect: vi.fn(),
    getActiveOperationsCount: vi.fn(),
    getStreamHistory: vi.fn(),
    publishAgentRuntimeEnd: vi.fn(),
    publishAgentRuntimeInit: vi.fn(),
    publishStreamChunk: vi.fn(),
    publishStreamEvent: vi.fn(),
    sendToolExecute,
    subscribeStreamEvents: vi.fn(),
  } as unknown as IStreamEventManager;
}

describe('dispatchClientTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createGatewayAttempt).mockImplementation(
      async (input) =>
        ({
          attemptId: 'attempt-1',
          attemptExpiresAt: input.attemptExpiresAt,
        }) as Awaited<ReturnType<typeof createGatewayAttempt>>,
    );
    vi.mocked(waitForGatewayResult).mockResolvedValue({
      outcome: 'completed',
      result: { content: 'file contents', success: true },
    } as Awaited<ReturnType<typeof waitForGatewayResult>>);
  });

  const dispatch = (send = vi.fn(), options = {}) =>
    dispatchClientTool(makePayload(), {
      operationId: 'op-1',
      streamManager: makeStreamManager(send),
      ...options,
    });

  it('returns gateway_unsupported without a notifier', async () => {
    const result = await dispatchClientTool(makePayload(), {
      operationId: 'op-1',
      streamManager: makeStreamManager(),
    });
    expect(result).toMatchObject({ success: false, error: { type: 'gateway_unsupported' } });
    expect(createGatewayAttempt).not.toHaveBeenCalled();
  });

  it('dispatches an authorized attempt and returns the matching callback', async () => {
    const send = vi.fn();
    expect(await dispatch(send)).toMatchObject({ success: true, content: 'file contents' });
    expect(send).toHaveBeenCalledWith(
      'op-1',
      expect.objectContaining({
        intent: expect.objectContaining({ attemptId: 'attempt-1' }),
        toolCallId: 'call-1',
      }),
    );
    expect(waitForGatewayResult).toHaveBeenCalledWith(
      { operationId: 'op-1', toolCallId: 'call-1', attemptId: 'attempt-1' },
      expect.objectContaining({ execution: { tenantId: 'test-tenant', sourceAcceptedVersion: 1 } }),
    );
  });

  it('preserves state, Work registration and device timing in a callback', async () => {
    const result = {
      success: true,
      content: 'created',
      state: { cursor: 7 },
      workRegistration: { action: 'create', targets: [{ taskId: 'task-9' }], type: 'task' },
      executionTimeMs: 5,
    };
    vi.mocked(waitForGatewayResult).mockResolvedValue({ outcome: 'completed', result } as never);
    expect(await dispatch()).toMatchObject({
      content: result.content,
      state: result.state,
      workRegistration: result.workRegistration,
      success: true,
      deviceExecutionTime: 5,
      executionTime: expect.any(Number),
    });
  });

  it('reports timeout when a completed wait has no tool result', async () => {
    vi.mocked(waitForGatewayResult).mockResolvedValue({
      outcome: 'completed',
      result: undefined,
    } as never);
    expect(await dispatch()).toMatchObject({ success: false, error: { type: 'timeout' } });
  });

  it('keeps an unconfirmed execution distinct from a completed tool failure', async () => {
    vi.mocked(waitForGatewayResult).mockResolvedValue({ outcome: 'executionUnknown' } as never);
    expect(await dispatch()).toMatchObject({ success: false, error: { type: 'executionUnknown' } });
  });

  it('preserves a device-reported failure', async () => {
    vi.mocked(waitForGatewayResult).mockResolvedValue({
      outcome: 'completed',
      result: {
        success: false,
        content: '',
        error: { type: 'permission_denied', message: 'denied' },
      },
    } as never);
    expect(await dispatch()).toMatchObject({
      success: false,
      error: { type: 'permission_denied' },
    });
  });

  it('returns dispatch_failed and does not wait after a send failure', async () => {
    expect(await dispatch(vi.fn().mockRejectedValue(new Error('send failed')))).toMatchObject({
      success: false,
      error: { type: 'dispatch_failed', message: 'send failed' },
    });
    expect(waitForGatewayResult).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, GLOBAL_DEFAULT_TIMEOUT_MS],
    [0, MIN_TIMEOUT_MS],
    [MAX_TIMEOUT_MS + 1, MAX_TIMEOUT_MS],
  ])('applies the execution budget %s as %s', async (timeoutMs, expected) => {
    const send = vi.fn();
    await dispatch(send, { timeoutMs });
    expect(send).toHaveBeenCalledWith(
      'op-1',
      expect.objectContaining({ executionTimeoutMs: expected }),
    );
  });
});
