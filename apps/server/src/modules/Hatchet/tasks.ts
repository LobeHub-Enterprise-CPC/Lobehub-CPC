import { createHash, randomUUID } from 'node:crypto';

import type { Context, Priority } from '@hatchet-dev/typescript-sdk/v1';
import {
  IdempotencyCollisionError,
  NonRetryableError,
  RetryAfterError,
} from '@hatchet-dev/typescript-sdk/v1';

import { getHatchetClient } from './client';
import { AGENT_STEP_TASK, DELIVERY_TASK, HATCHET_TIMING } from './config';
import { deliver } from './deliver';
import { trackPublish } from './pending';
import { compileRetryDelay } from './retryDelay';
import { type DeliveryInput, MAX_MESSAGE_RETRIES, TASK_RETRIES } from './types';

// The SDK requires JSON object types for run input and output, which an
// interface cannot satisfy (it has no index signature), hence type aliases.
type DeliveryTaskInput = Pick<DeliveryInput, keyof DeliveryInput>;
type DeliveryTaskOutput = { status: number };

const runDelivery = async (
  input: DeliveryTaskInput,
  ctx: Context<DeliveryTaskInput>,
): Promise<DeliveryTaskOutput> => {
  const outcome = await deliver(input, {
    attempt: ctx.retryCount(),
    messageId: ctx.taskRunExternalId(),
  });
  switch (outcome.kind) {
    case 'delivered': {
      return { status: outcome.status };
    }
    case 'retry': {
      throw new RetryAfterError(outcome.reason, { after: outcome.afterMs });
    }
    case 'failed': {
      throw new NonRetryableError(outcome.reason);
    }
  }
};

/**
 * Both tasks deliver one QStash-style message; they differ only in how long
 * an attempt may run or wait in the queue. `retries` is a ceiling:
 * each message's own budget is enforced by `deliver`.
 */
const declareDeliveryTask = (
  name: string,
  { executionTimeoutMs, queueTimeoutMs }: { executionTimeoutMs: number; queueTimeoutMs: number },
) =>
  getHatchetClient().task<DeliveryTaskInput, DeliveryTaskOutput>({
    executionTimeout: executionTimeoutMs,
    fn: runDelivery,
    idempotency: {
      expression: 'input.dedupKey',
      strategy: 'ttl',
      ttlMs: HATCHET_TIMING.dedupTtlMs,
    },
    name,
    retries: TASK_RETRIES,
    scheduleTimeout: queueTimeoutMs,
  });

export type DeliveryTask = ReturnType<typeof declareDeliveryTask>;

// Declared on first use: this module is imported in every mode, Hatchet or not.
let agentStepTask: DeliveryTask | undefined;
let deliveryTask: DeliveryTask | undefined;

export const getAgentStepTask = (): DeliveryTask =>
  (agentStepTask ??= declareDeliveryTask(AGENT_STEP_TASK, {
    executionTimeoutMs: HATCHET_TIMING.stepExecutionTimeoutMs,
    queueTimeoutMs: HATCHET_TIMING.queueTimeoutMs,
  }));

export const getDeliveryTask = (): DeliveryTask =>
  (deliveryTask ??= declareDeliveryTask(DELIVERY_TASK, {
    executionTimeoutMs: HATCHET_TIMING.deliveryExecutionTimeoutMs,
    queueTimeoutMs: HATCHET_TIMING.deliveryQueueTimeoutMs,
  }));

/** Publisher deduplication ids are only unique within a tenant. */
export const deliveryDedupKey = (tenantKey: string, deduplicationId?: string): string =>
  deduplicationId
    ? createHash('sha256').update(`${tenantKey}:${deduplicationId}`).digest('hex')
    : randomUUID();

/** Refuse at publish time what the delivery would only fail on later. */
export const assertRetryPolicy = (retries: number, retryDelay?: string): void => {
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_MESSAGE_RETRIES)
    throw new Error(`retries must be an integer from 0 to ${MAX_MESSAGE_RETRIES}, got ${retries}`);
  if (retryDelay === undefined) return;
  try {
    compileRetryDelay(retryDelay);
  } catch (error) {
    throw new Error(`Invalid retryDelay expression ${JSON.stringify(retryDelay)}`, {
      cause: error,
    });
  }
};

/**
 * The engine and the SDK both cap a gRPC message at 16 MiB. The body was
 * already clamped to the QStash budget, but as a string inside the input
 * every quote and backslash is escaped again, so measure the whole input.
 */
const MAX_INPUT_BYTES = 15 * 1024 * 1024;

/** Below this a delay is not worth a schedule. */
const MIN_SCHEDULE_DELAY_MS = 1000;

/** Message ids name what to cancel: a run, or a schedule that has not fired yet. */
export const RUN_ID_PREFIX = 'run_';
export const SCHEDULE_ID_PREFIX = 'sched_';

interface TriggerOptions {
  /** String values only; also names the message in errors. */
  additionalMetadata: Record<string, string>;
  delayMs: number;
  priority?: Priority;
}

const trigger = async (
  task: DeliveryTask,
  input: DeliveryTaskInput,
  { delayMs, ...options }: TriggerOptions,
): Promise<string> => {
  try {
    if (delayMs < MIN_SCHEDULE_DELAY_MS) {
      const run = await task.runNoWait(input, options);
      return `${RUN_ID_PREFIX}${await run.runId}`;
    }
    // Idempotency is checked when a schedule fires, not when it is created
    // (engine v0.114): a schedule whose key is taken by then is dropped at
    // that point, so a duplicate schedule needs no handling here.
    const scheduled = await task.schedule(new Date(Date.now() + delayMs), input, options);
    return `${SCHEDULE_ID_PREFIX}${scheduled.metadata.id}`;
  } catch (error) {
    if (error instanceof IdempotencyCollisionError)
      return `${RUN_ID_PREFIX}${error.existingRunExternalId}`;
    throw error;
  }
};

/**
 * Hand one delivery to Hatchet, as a run now or a schedule for later.
 * Resolves to `run_<run id>` or `sched_<schedule id>`; a deduplicated
 * message resolves to the run that already holds its key.
 */
export const triggerDelivery = async (
  task: DeliveryTask,
  input: DeliveryInput,
  options: TriggerOptions,
): Promise<string> => {
  const target = new URL(input.url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    throw new Error(`Hatchet delivers to http(s) URLs only, got ${target.protocol}`);
  const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if (bytes > MAX_INPUT_BYTES)
    throw new Error(
      `${task.name} input for ${JSON.stringify(options.additionalMetadata)} is ${bytes} bytes, over the ${MAX_INPUT_BYTES} byte limit`,
    );

  return trackPublish(trigger(task, input, options));
};
