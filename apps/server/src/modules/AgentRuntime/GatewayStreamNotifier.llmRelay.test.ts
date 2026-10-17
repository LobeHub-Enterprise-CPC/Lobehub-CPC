import urlJoin from 'url-join';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayStreamNotifier } from './GatewayStreamNotifier';
import type { IStreamEventManager } from './types';

const mockFetch = vi.hoisted(() => vi.fn());
// Exercise retained upstream relay routing independently of the tenancy entry gate.
vi.mock('./gatewayHttp', () => ({
  gatewayOperationPost: async (
    url: string,
    token: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ) => {
    const response = await mockFetch(urlJoin(url, path), {
      method: 'POST',
      signal,
      body: JSON.stringify(body),
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  },
}));

describe('GatewayStreamNotifier retained upstream relay', () => {
  const gatewayUrl = 'https://gateway.test.com';
  const serviceToken = 'TEST-ONLY';
  let notifier: GatewayStreamNotifier;
  beforeEach(() => {
    mockFetch.mockReset();
    notifier = new GatewayStreamNotifier(
      { publishStreamEvent: vi.fn(async () => 'id') } as unknown as IStreamEventManager,
      gatewayUrl,
      serviceToken,
    );
  });
  describe('LLM relay routes', () => {
    const executeData = {
      attempt: 0,
      callId: 'op-1:2:0',
      deadlines: { claimMs: 15_000, firstChunkMs: 120_000, idleMs: 60_000, totalMs: 540_000 },
      leaseToken: 'lease',
      model: 'llama3',
      operationId: 'op-1',
      preferredClientId: 'tab-a',
      provider: 'ollama',
      runtimeProvider: 'ollama',
      stepIndex: 2,
    };

    const callsTo = (path: string) =>
      mockFetch.mock.calls.filter((c: any[]) => String(c[0]).endsWith(path));

    beforeEach(() => {
      mockFetch.mockReset();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"delivered":1,"success":true}'),
      });
    });

    it('sends llm_execute to the routed endpoint, not as a broadcast stream event', async () => {
      const result = await notifier.sendLlmExecute('op-1', executeData);

      expect(result).toEqual({ delivered: 1, routed: true });
      const [call] = callsTo('/api/operations/llm-execute');
      expect(call[0]).toBe(`${gatewayUrl}/api/operations/llm-execute`);
      expect(call[1].headers.Authorization).toBe(`Bearer ${serviceToken}`);
      expect(JSON.parse(call[1].body)).toEqual({ data: executeData, operationId: 'op-1' });
      expect(callsTo('/api/operations/push-event')).toHaveLength(0);
    });

    it('cancels and closes a call through their routes', async () => {
      await notifier.sendLlmCancel('op-1', {
        callId: 'op-1:2:0',
        reason: 'interrupted',
        stepIndex: 2,
      });
      await notifier.closeLlmCall('op-1', 'op-1:2:0');

      expect(JSON.parse(callsTo('/api/operations/llm-cancel')[0][1].body)).toEqual({
        data: { callId: 'op-1:2:0', reason: 'interrupted' },
        operationId: 'op-1',
      });
      expect(JSON.parse(callsTo('/api/operations/llm-close')[0][1].body)).toEqual({
        callId: 'op-1:2:0',
        operationId: 'op-1',
      });
    });

    it('falls back to a plain stream event on a gateway without the routes (404), and remembers it', async () => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('/llm-')
            ? { ok: false, status: 404, text: () => Promise.resolve('404 page not found') }
            : { ok: true, status: 200, text: () => Promise.resolve('') },
        ),
      );

      expect(await notifier.sendLlmExecute('op-1', executeData)).toEqual({ routed: false });
      await notifier.sendLlmCancel('op-1', { callId: 'op-1:2:0', reason: 'timeout', stepIndex: 2 });
      await notifier.closeLlmCall('op-1', 'op-1:2:0');
      await vi.waitFor(() => expect(callsTo('/api/operations/push-event')).toHaveLength(2));

      const pushed = callsTo('/api/operations/push-event').map(
        (c: any[]) => JSON.parse(c[1].body).event,
      );
      expect(pushed.map((e: any) => e.type)).toEqual(['llm_execute', 'llm_cancel']);
      expect(pushed[0]).toMatchObject({ data: executeData, operationId: 'op-1', stepIndex: 2 });
      expect(pushed[1].data).toEqual({ callId: 'op-1:2:0', reason: 'timeout' });
      // Only the first relay call probed the route; cancel and close did not.
      expect(callsTo('/api/operations/llm-execute')).toHaveLength(1);
      expect(callsTo('/api/operations/llm-cancel')).toHaveLength(0);
      expect(callsTo('/api/operations/llm-close')).toHaveLength(0);
    });

    it('opens a one-shot relay channel for its user and ends it when the request is done', async () => {
      const channel = 'llmcall:user-1:0b7c1d2e-aaaa';

      await notifier.openLlmRelayChannel(channel, 'user-1');
      await notifier.closeLlmRelayChannel(channel);

      expect(JSON.parse(callsTo('/api/operations/init')[0][1].body)).toEqual({
        meta: { scope: 'llm_call' },
        operationId: channel,
        userId: 'user-1',
      });
      expect(JSON.parse(callsTo('/api/operations/update-status')[0][1].body)).toEqual({
        operationId: channel,
        status: 'completed',
      });
    });

    it('rejects opening a one-shot channel the gateway refuses, but never a failed close', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });

      await expect(
        notifier.openLlmRelayChannel('llmcall:user-1:abcdefgh', 'user-1'),
      ).rejects.toThrow('500');
      await expect(
        notifier.closeLlmRelayChannel('llmcall:user-1:abcdefgh'),
      ).resolves.toBeUndefined();
    });

    it('stops probing the relay routes once a close returns 404', async () => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('/llm-close')
            ? { ok: false, status: 404, text: () => Promise.resolve('404 page not found') }
            : { ok: true, status: 200, text: () => Promise.resolve('') },
        ),
      );

      await notifier.closeLlmCall('op-1', 'op-1:2:0');
      await notifier.closeLlmCall('op-1', 'op-1:2:1');

      expect(callsTo('/api/operations/llm-close')).toHaveLength(1);
      expect(await notifier.sendLlmExecute('op-1', executeData)).toEqual({ routed: false });
    });

    it('times out a gateway that sends headers and then stalls the body', async () => {
      vi.useFakeTimers();
      try {
        // Headers arrive; the body never does until the request is aborted.
        mockFetch.mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              new Promise((_resolve, reject) => {
                init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
              }),
          }),
        );

        const execute = notifier.sendLlmExecute('op-1', executeData);
        const tool = notifier.sendToolExecute('op-1', {
          intent: {} as never,
          apiName: 'readFile',
          arguments: '{}',
          executionTimeoutMs: 30_000,
          identifier: 'local-system',
          toolCallId: 'call-1',
        });
        const settled = Promise.allSettled([execute, tool]);
        await vi.advanceTimersByTimeAsync(60_000);

        const [executeResult, toolResult] = await settled;
        expect(executeResult).toMatchObject({ reason: expect.any(Error), status: 'rejected' });
        expect(toolResult).toMatchObject({ reason: expect.any(Error), status: 'rejected' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects when the gateway refuses the dispatch for another reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () => Promise.resolve('{"delivered":0,"error":"OPERATION_ENDED"}'),
      });

      await expect(notifier.sendLlmExecute('op-1', executeData)).rejects.toThrow(/409/);
      expect(callsTo('/api/operations/push-event')).toHaveLength(0);
    });
  });
});
