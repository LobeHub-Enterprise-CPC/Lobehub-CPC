import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as GatewayHttp from './gatewayHttp';
import { GatewayStreamNotifier } from './GatewayStreamNotifier';
import type { StreamChunkData } from './StreamEventManager';
import type { IStreamEventManager } from './types';

const mockPost = vi.hoisted(() => vi.fn());
// The connect-failure classification stays real; only the wire is replaced.
vi.mock('./gatewayHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof GatewayHttp>()),
  gatewayOperationPost: (_url: string, _token: string, path: string, body: unknown) =>
    mockPost(path, body),
}));

const unreachable = (code: string) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
const delivered = { body: '', ok: true, status: 200 };

// A gateway restart leaves its Service without a ready Pod for a few seconds.
// A request that never connected cannot have been delivered, so it is safe to
// send again once the gateway is back; anything that may have reached the
// gateway is not resent.
describe('GatewayStreamNotifier while the gateway is unreachable', () => {
  let notifier: GatewayStreamNotifier;
  const calls = (path: string) => mockPost.mock.calls.filter((c) => c[0] === path);

  beforeEach(() => {
    mockPost.mockReset().mockResolvedValue(delivered);
    notifier = new GatewayStreamNotifier(
      {
        publishAgentRuntimeInit: vi.fn(async () => 'init-id'),
        publishStreamChunk: vi.fn(async () => 'chunk-id'),
        publishStreamEvent: vi.fn(async () => 'event-id'),
      } as unknown as IStreamEventManager,
      'https://gateway.test.com',
      'TEST-ONLY',
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resends an awaited init that never connected, once the gateway is back', async () => {
    vi.useFakeTimers();
    mockPost
      .mockRejectedValueOnce(unreachable('UND_ERR_CONNECT_TIMEOUT'))
      .mockRejectedValueOnce(unreachable('ECONNREFUSED'));

    const init = notifier.publishAgentRuntimeInit('op-1', { userId: 'user-1' });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(init).resolves.toBe('init-id');
    expect(calls('/api/operations/init')).toHaveLength(3);
  });

  it('does not resend a request that may have reached the gateway', async () => {
    mockPost.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      }),
    );

    await expect(notifier.publishAgentRuntimeInit('op-1', { userId: 'user-1' })).rejects.toThrow();
    expect(calls('/api/operations/init')).toHaveLength(1);
  });

  it('gives up on an unreachable gateway after a bounded window', async () => {
    vi.useFakeTimers();
    mockPost.mockRejectedValue(unreachable('UND_ERR_CONNECT_TIMEOUT'));

    const settled = expect(
      notifier.publishAgentRuntimeInit('op-1', { userId: 'user-1' }),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;
  });

  it('resends run events once the gateway is back, but leaves stream chunks to stream_end', async () => {
    await notifier.publishAgentRuntimeInit('op-1', { userId: 'user-1' });
    await notifier.drainPushes('op-1');
    mockPost.mockClear();
    vi.useFakeTimers();
    mockPost
      .mockRejectedValueOnce(unreachable('UND_ERR_CONNECT_TIMEOUT'))
      .mockRejectedValueOnce(unreachable('UND_ERR_CONNECT_TIMEOUT'));

    await notifier.publishStreamChunk('op-1', 0, {
      chunkType: 'text',
      content: 'lost',
    } as StreamChunkData);
    await vi.advanceTimersByTimeAsync(0);
    await notifier.publishStreamEvent('op-1', {
      data: {},
      stepIndex: 0,
      type: 'step_complete' as const,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    const pushed = calls('/api/operations/push-event').map((c) => (c[1] as any).event.type);
    // The chunk: one failed attempt. step_complete: one failed attempt, then delivered.
    expect(pushed).toEqual(['stream_chunk', 'step_complete', 'step_complete']);
  });
});
