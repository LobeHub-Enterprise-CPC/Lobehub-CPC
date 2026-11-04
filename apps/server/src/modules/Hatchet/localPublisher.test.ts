// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.hoisted(() => vi.fn());
vi.mock('./deliver', () => ({ deliver }));

const { LocalPublisher } = await import('./localPublisher');

const url = 'http://localhost:3210/api/workflows/task/heartbeat-tick';

describe('LocalPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    deliver.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers after the delay and retries as the delivery asks', async () => {
    deliver
      .mockResolvedValueOnce({ afterMs: 2000, kind: 'retry', reason: 'HTTP 500' })
      .mockResolvedValueOnce({ kind: 'delivered', status: 200 });
    const publisher = new LocalPublisher();

    await publisher.publishJSON({ body: { taskId: 't' }, delay: 5, url });
    await vi.advanceTimersByTimeAsync(4999);
    expect(deliver).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ body: '{"taskId":"t"}', url });
    expect(deliver.mock.calls[0][1]).toMatchObject({ attempt: 0 });

    await vi.advanceTimersByTimeAsync(2000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][1]).toMatchObject({ attempt: 1 });
  });

  it('drops a duplicate within the dedup window and cancels a pending message', async () => {
    deliver.mockResolvedValue({ kind: 'delivered', status: 200 });
    const publisher = new LocalPublisher();

    const first = await publisher.publishJSON({ deduplicationId: 'd', delay: 10, url });
    const second = await publisher.publishJSON({ deduplicationId: 'd', delay: 10, url });
    expect(second.messageId).toBe(first.messageId);

    await publisher.messages.delete(first.messageId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses options a delivery cannot honour', async () => {
    const publisher = new LocalPublisher();
    await expect(publisher.publishJSON({ url, ...({ callback: 'x' } as object) })).rejects.toThrow(
      'does not support callback',
    );
  });
});
