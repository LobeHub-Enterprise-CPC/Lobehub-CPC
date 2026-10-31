/**
 * One HTTP delivery in QStash terms, as carried by both Hatchet delivery tasks
 * (`cpc-agent-step` and `cpc-delivery`). The task input is immutable for the
 * life of the run, so everything a retry needs to deliver the same request is
 * in here.
 */
export interface DeliveryInput {
  /** Exact request body sent on every attempt; the signature covers these bytes. */
  body: string;
  /** Idempotency key: derived from the publisher's deduplication id, or random when it had none. */
  dedupKey: string;
  /** Business headers to forward. Reserved transport headers are written by the delivery itself. */
  headers: Record<string, string>;
  /** Retries after the first attempt, as in QStash: at most `1 + retries` attempts. */
  retries: number;
  /** QStash `retryDelay` expression: milliseconds, with `retried` bound to the retry number. */
  retryDelay?: string;
  /** Concurrency group: the tenant the message belongs to. */
  tenantKey: string;
  /** Per-attempt HTTP timeout. */
  timeoutMs: number;
  /** Destination exactly as the publisher addressed it. */
  url: string;
}

export interface DeliveryAttempt {
  /** 0-based attempt number (the Hatchet retry count of this run). */
  attempt: number;
  /** Stable across the attempts of one message: the Hatchet run external id. */
  messageId: string;
}

export type DeliveryOutcome =
  | { kind: 'delivered'; status: number }
  /** Try again after `afterMs`; only returned while the message still has retries left. */
  | { afterMs: number; kind: 'retry'; reason: string; status?: number }
  /** Final: the receiver refused it as non-retryable, or the retry budget is spent. */
  | { kind: 'failed'; reason: string; status?: number };

/**
 * Hatchet runs one attempt more than its `retries` option, and a lost worker
 * counts against it too, so a message may ask for at most this many retries.
 */
export const MAX_MESSAGE_RETRIES = 19;

/** Task-level ceiling; per-message budgets are enforced by the delivery itself. */
export const TASK_RETRIES = MAX_MESSAGE_RETRIES + 1;
