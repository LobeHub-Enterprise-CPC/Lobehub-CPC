import { parseTenantPath } from '@lobechat/business-tenant/routing';
import { currentTenantScope } from '@lobechat/database/tenant';
import { isRecord } from '@lobechat/utils/object';

import { getHatchetClient } from './client';
import { HATCHET_TIMING } from './config';
import { STEP_METADATA_KEYS } from './purpose';
import {
  assertRetryPolicy,
  deliveryDedupKey,
  getDeliveryTask,
  RUN_ID_PREFIX,
  SCHEDULE_ID_PREFIX,
  triggerDelivery,
} from './tasks';
import type { DeliveryInput } from './types';

type QStashDuration = `${bigint}${'d' | 'h' | 'm' | 's'}`;

/** The part of QStash `publishJSON` this repository uses. Any other option is refused. */
export interface DirectPublishRequest {
  /** Sent as JSON, strings included, as `publishJSON` does. */
  body?: unknown;
  deduplicationId?: string;
  /** Seconds, or a QStash duration (`30s`, `5m`, `2h`, `1d`). */
  delay?: number | QStashDuration;
  headers?: Record<string, string>;
  /** Unix time in seconds; wins over `delay`. */
  notBefore?: number;
  retries?: number;
  retryDelay?: string;
  /** Per-attempt HTTP timeout: seconds, or a QStash duration. */
  timeout?: number | QStashDuration;
  url: string;
}

const SUPPORTED_OPTIONS: Record<keyof DirectPublishRequest, true> = {
  body: true,
  deduplicationId: true,
  delay: true,
  headers: true,
  notBefore: true,
  retries: true,
  retryDelay: true,
  timeout: true,
  url: true,
};

const DURATION_UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;

/** An attempt has to end, and its outcome be recorded, before the task itself times out. */
const MAX_TIMEOUT_MS = HATCHET_TIMING.deliveryExecutionTimeoutMs - 60_000;

const durationMs = (option: string, value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value * 1000;
  const match = typeof value === 'string' ? /^(\d+)([dhms])$/.exec(value) : null;
  if (match) return Number(match[1]) * DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS];
  throw new Error(
    `${option} must be seconds or a duration such as 30s, 5m, 2h or 1d, got ${JSON.stringify(value)}`,
  );
};

const delayMsOf = ({ delay, notBefore }: DirectPublishRequest, now: number): number => {
  if (notBefore === undefined) return delay === undefined ? 0 : durationMs('delay', delay);
  if (!Number.isFinite(notBefore)) throw new Error('notBefore must be a Unix time in seconds');
  return notBefore * 1000 - now;
};

const timeoutMsOf = ({ timeout }: DirectPublishRequest): number => {
  if (timeout === undefined) return HATCHET_TIMING.deliveryHttpTimeoutMs;
  const timeoutMs = durationMs('timeout', timeout);
  if (timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
    throw new Error(
      `timeout must be above 0 and at most ${MAX_TIMEOUT_MS / 1000}s, got ${JSON.stringify(timeout)}`,
    );
  return timeoutMs;
};

/** Business headers as `publishJSON` forwards them, which always sends JSON. */
const headersOf = ({ headers }: DirectPublishRequest): Record<string, string> => {
  const forwarded = new Headers(headers);
  for (const name of forwarded.keys()) {
    // QStash reads these as publish options rather than forwarding them.
    if (name.startsWith('upstash-') && !name.startsWith('upstash-forward-'))
      throw new Error(`header ${name} is a QStash option, which this publisher does not support`);
  }
  forwarded.set('Content-Type', 'application/json');
  return Object.fromEntries(forwarded);
};

/** A tenant-prefixed app address names its tenant; otherwise the publishing request's tenant. */
const tenantKeyOf = (url: URL): string => {
  // The app's own origins, as deliveries tell them apart (resolveDeliveryTarget).
  const appOrigins = [
    process.env.APP_URL,
    process.env.INTERNAL_APP_URL,
    process.env.AGENT_RUNTIME_BASE_URL,
  ]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value).origin);
  const tenantSlug = appOrigins.includes(url.origin)
    ? parseTenantPath(url.pathname).tenantSlug
    : undefined;
  return tenantSlug ?? currentTenantScope()?.tenantId ?? '_';
};

const isNotFound = (error: unknown): boolean =>
  isRecord(error) && isRecord(error.response) && error.response.status === 404;

/**
 * Direct deliveries through the `cpc-delivery` task, in place of the QStash
 * client: the same request shape, each one signed and delivered by a Hatchet
 * worker like a QStash message would be.
 */
export class HatchetPublisher {
  /**
   * Best-effort cancel, as with QStash: receivers re-check the database, so a
   * target that already ran or no longer exists is not an error.
   */
  readonly messages = {
    delete: async (messageId: string): Promise<void> => {
      try {
        if (messageId.startsWith(SCHEDULE_ID_PREFIX))
          await getHatchetClient().schedules.delete(messageId.slice(SCHEDULE_ID_PREFIX.length));
        else if (messageId.startsWith(RUN_ID_PREFIX))
          await getHatchetClient().runs.cancel({ ids: [messageId.slice(RUN_ID_PREFIX.length)] });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };

  async publishJSON(request: DirectPublishRequest): Promise<{ messageId: string }> {
    const unsupported = Object.entries(request)
      .filter(([key, value]) => value !== undefined && !Object.hasOwn(SUPPORTED_OPTIONS, key))
      .map(([key]) => key);
    if (unsupported.length > 0)
      throw new Error(`HatchetPublisher does not support ${unsupported.join(', ')}`);

    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      throw new Error('HatchetPublisher needs an absolute URL');
    }

    const { deduplicationId, retries = 3, retryDelay } = request;
    assertRetryPolicy(retries, retryDelay);
    const tenantKey = tenantKeyOf(target);
    const input: DeliveryInput = {
      body: JSON.stringify(request.body) ?? '',
      dedupKey: deliveryDedupKey(tenantKey, deduplicationId),
      headers: headersOf(request),
      retries,
      ...(retryDelay === undefined ? {} : { retryDelay }),
      tenantKey,
      timeoutMs: timeoutMsOf(request),
      url: request.url,
    };

    const messageId = await triggerDelivery(getDeliveryTask(), input, {
      additionalMetadata: {
        [STEP_METADATA_KEYS.kind]: 'delivery',
        [STEP_METADATA_KEYS.tenantId]: tenantKey,
      },
      delayMs: delayMsOf(request, Date.now()),
    });
    return { messageId };
  }
}
