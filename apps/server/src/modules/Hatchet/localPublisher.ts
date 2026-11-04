import { randomUUID } from 'node:crypto';

import debug from 'debug';

import { HATCHET_TIMING } from './config';
import { deliver } from './deliver';
import { type DirectPublishRequest, toDeliveryInput } from './publisher';
import type { DeliveryInput } from './types';

const log = debug('lobe-server:delivery:local');

const LOCAL_ID_PREFIX = 'local_';

/**
 * Direct deliveries without a queue (local mode: dev and desktop). Each message
 * is delivered by this process after its delay, with the same signing, retry
 * policy and deduplication window as a Hatchet delivery, but nothing survives a
 * restart.
 */
export class LocalPublisher {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly seen = new Map<string, { expiresAt: number; messageId: string }>();

  readonly messages = {
    delete: async (messageId: string): Promise<void> => {
      clearTimeout(this.timers.get(messageId));
      this.timers.delete(messageId);
    },
  };

  async publishJSON(request: DirectPublishRequest): Promise<{ messageId: string }> {
    const now = Date.now();
    const { delayMs, input } = toDeliveryInput(request, now);

    for (const [key, entry] of this.seen) if (entry.expiresAt <= now) this.seen.delete(key);
    if (request.deduplicationId) {
      const existing = this.seen.get(input.dedupKey);
      if (existing) return { messageId: existing.messageId };
    }

    const messageId = `${LOCAL_ID_PREFIX}${randomUUID()}`;
    if (request.deduplicationId)
      this.seen.set(input.dedupKey, { expiresAt: now + HATCHET_TIMING.dedupTtlMs, messageId });
    this.schedule(input, messageId, 0, Math.max(0, delayMs));
    return { messageId };
  }

  private schedule(input: DeliveryInput, messageId: string, attempt: number, delayMs: number) {
    const timer = setTimeout(() => {
      this.timers.delete(messageId);
      void this.attempt(input, messageId, attempt);
    }, delayMs);
    timer.unref?.();
    this.timers.set(messageId, timer);
  }

  private async attempt(input: DeliveryInput, messageId: string, attempt: number) {
    const outcome = await deliver(input, { attempt, messageId });
    if (outcome.kind === 'retry') {
      log(
        'retry %s attempt=%d in %dms: %s',
        input.url,
        attempt + 1,
        outcome.afterMs,
        outcome.reason,
      );
      this.schedule(input, messageId, attempt + 1, outcome.afterMs);
    } else if (outcome.kind === 'failed') {
      console.error('[delivery:local] %s failed: %s', input.url, outcome.reason);
    }
  }
}
