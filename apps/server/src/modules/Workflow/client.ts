import { randomUUID } from 'node:crypto';

import { recordUpstashWorkflowEvent } from '@lobechat/observability-otel/modules/upstash-workflow';
import { errorNameFrom } from '@lobechat/utils';

import { getDirectDeliveryClient } from '@/server/modules/Hatchet/directDelivery';
import type { DirectPublishRequest } from '@/server/modules/Hatchet/publisher';

import { getWorkflowStore } from './store';
import type { FlowControl, WorkflowEnvelope, WorkflowParent } from './types';

/** Upstash Workflow's default: three retries of each delivery. */
export const DEFAULT_WORKFLOW_RETRIES = 3;

const RUN_ID_PREFIX = 'wfr_';

export interface TriggerOptions {
  body?: unknown;
  /** Seconds, or a duration such as `30s`, before the run starts. */
  delay?: DirectPublishRequest['delay'];
  flowControl?: FlowControl;
  headers?: Headers | Record<string, string>;
  /** Accepted for call-site compatibility; runs are not labelled. */
  label?: string;
  retries?: number;
  retryDelay?: string;
  /** Absolute address of the route that serves the workflow. */
  url: string;
  /** A stable id makes the trigger idempotent within the delivery dedup window. */
  workflowRunId?: string;
}

export interface TriggerResult {
  workflowRunId: string;
}

const toRunId = (id?: string) =>
  !id ? `${RUN_ID_PREFIX}${randomUUID()}` : id.startsWith(RUN_ID_PREFIX) ? id : RUN_ID_PREFIX + id;

const toHeaders = (headers?: Headers | Record<string, string>) =>
  headers instanceof Headers ? Object.fromEntries(headers.entries()) : { ...headers };

/** Publishes one delivery of a run: its trigger or a continuation. */
export const publishEnvelope = async (
  envelope: WorkflowEnvelope,
  delay?: TriggerOptions['delay'],
): Promise<void> => {
  const { retries, retryDelay, runId, seq, url } = envelope.workflow;
  await getDirectDeliveryClient().publishJSON({
    body: envelope,
    deduplicationId: `${runId}:${seq}`,
    ...(delay ? { delay } : {}),
    headers: envelope.headers,
    retries,
    ...(retryDelay === undefined ? {} : { retryDelay }),
    url,
  });
};

const triggerOne = async (
  options: TriggerOptions,
  parent?: WorkflowParent,
): Promise<TriggerResult> => {
  const { body, delay, flowControl, headers, retries, retryDelay, url } = options;
  const runId = toRunId(options.workflowRunId);
  const envelope: WorkflowEnvelope = {
    headers: toHeaders(headers),
    payload: body,
    workflow: {
      ...(flowControl ? { flowControl } : {}),
      ...(parent ? { parent } : {}),
      retries: retries ?? DEFAULT_WORKFLOW_RETRIES,
      ...(retryDelay === undefined ? {} : { retryDelay }),
      runId,
      seq: 0,
      url,
      v: 1,
    },
  };

  try {
    await getWorkflowStore().registerActive(runId, url);
    await publishEnvelope(envelope, delay);
    recordUpstashWorkflowEvent({
      interface: 'workflow',
      label: options.label,
      operation: 'trigger',
      retries,
      retryDelay,
      status: 'success',
      url,
      workflowRunId: runId,
    });
    return { workflowRunId: runId };
  } catch (error) {
    recordUpstashWorkflowEvent({
      errorType: errorNameFrom(error) ?? typeof error,
      interface: 'workflow',
      label: options.label,
      operation: 'trigger',
      retries,
      retryDelay,
      status: 'error',
      url,
      workflowRunId: runId,
    });
    throw error;
  }
};

/** Starts a child run that reports back to `parent` when it ends. */
export const triggerChild = (options: TriggerOptions, parent: WorkflowParent) =>
  triggerOne(options, parent);

function trigger(options: TriggerOptions): Promise<TriggerResult>;
function trigger(options: TriggerOptions[]): Promise<TriggerResult[]>;
async function trigger(
  options: TriggerOptions | TriggerOptions[],
): Promise<TriggerResult | TriggerResult[]> {
  if (Array.isArray(options)) return Promise.all(options.map((option) => triggerOne(option)));
  return triggerOne(options);
}

/**
 * Marks runs canceled, by id or by URL prefix. A run notices at its next
 * delivery or step; one that already ended keeps its status.
 */
const cancel = async ({
  ids,
  urlStartingWith,
}: {
  ids?: string[];
  urlStartingWith?: string;
}): Promise<{ cancelled: number }> => {
  const store = getWorkflowStore();
  const targets = new Set(ids ?? []);
  if (urlStartingWith)
    for (const runId of await store.activeRunsWithPrefix(urlStartingWith)) targets.add(runId);

  let cancelled = 0;
  for (const runId of targets) {
    if (await store.getStatus(runId)) continue;
    await store.setStatus(runId, 'canceled');
    cancelled += 1;
  }
  return { cancelled };
};

/** Drop-in for the Upstash Workflow client methods this repository uses. */
export const workflowClient = { cancel, trigger };
