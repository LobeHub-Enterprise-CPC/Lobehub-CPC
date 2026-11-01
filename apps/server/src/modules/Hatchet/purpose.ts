import type { QueueMessage } from '@/server/services/queue/types';

/**
 * What a queued agent-runtime message does when it lands, as far as recovery
 * cares. The reaper only treats `step` and `resume` deliveries as an owner of
 * the operation's next step:
 *
 * - `step`: a plain "run step N" delivery. It runs the delivered step, or the
 *   step a parked inline envelope points at when that one is further ahead.
 * - `resume`: carries a one-shot payload (human input, an approval, an async
 *   tool or client LLM resume) and runs as itself at its step index.
 * - `control`: a lock-free watchdog that executes no step (group member
 *   deadline, async-tool barrier check, client wait expiry).
 * - `job`: tenant-scoped work with no operation step behind it.
 *
 * Mirrors how `runStep` reads the payload (`isPlainStepDelivery`) and how
 * `runLockFreeDelivery` picks watchdogs; a new payload field there needs a
 * decision here too.
 */
export type DeliveryPurpose = 'control' | 'job' | 'resume' | 'step';

/** `runLockFreeDelivery` branches on these being truthy. */
const CONTROL_FLAGS = ['clientLlmWaitExpired', 'groupMemberTimeout', 'verifyAsyncToolBarrier'];
/** `isPlainStepDelivery` treats any defined value of these as a one-shot payload. */
const RESUME_VALUES = ['approvedToolCall', 'humanInput', 'rejectionReason', 'toolMessageId'];
/** ...and these only when truthy. */
const RESUME_FLAGS = [
  'finishAfterAsyncTool',
  'rejectAndContinue',
  'resumeAsyncTool',
  'resumeClientLlm',
];

export const classifyQueueMessage = (message: QueueMessage): DeliveryPurpose => {
  if (message.kind === 'tenant-job') return 'job';

  const payload: Record<string, unknown> =
    message.payload && typeof message.payload === 'object' ? message.payload : {};
  if (CONTROL_FLAGS.some((field) => Boolean(payload[field]))) return 'control';
  if (
    RESUME_VALUES.some((field) => payload[field] !== undefined) ||
    RESUME_FLAGS.some((field) => Boolean(payload[field]))
  )
    return 'resume';
  return 'step';
};

/** `additionalMetadata` keys on `cpc-agent-step` runs and schedules; values are strings. */
export const STEP_METADATA_KEYS = {
  kind: 'kind',
  operationId: 'operationId',
  purpose: 'purpose',
  stepIndex: 'stepIndex',
  tenantId: 'tenantId',
} as const;
