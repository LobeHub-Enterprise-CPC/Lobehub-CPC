import { randomUUID } from 'node:crypto';

import debug from 'debug';
import type { Context } from 'hono';

import { getDeliverySigningKey, verifyDeliveryRequest } from '@/server/modules/Hatchet/signature';

import { publishEnvelope, triggerChild, type TriggerOptions } from './client';
import { WorkflowAbort, WorkflowCanceled, WorkflowNonRetryableError } from './errors';
import { getWorkflowStore, type WorkflowStore } from './store';
import type { FlowControl, InvokeResult, WorkflowEnvelope } from './types';

const log = debug('lobe-server:workflow');

/** A run's lock and flow-control slots expire this long after their last renewal. */
const LEASE_MS = 90_000;
const RENEW_EVERY_MS = 30_000;
/** After this much work in one delivery, the next step boundary hands over to a fresh delivery. */
const DELIVERY_BUDGET_MS = 5 * 60_000;
/** How long a throttled run waits before it asks for a slot again. */
const THROTTLE_RETRY_MS = 5000;

type Duration = number | `${number}${'d' | 'h' | 'm' | 's'}`;

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as const;

/** Seconds, or a duration such as `30s`, in milliseconds. */
const durationMs = (value: Duration): number => {
  if (typeof value === 'number') return value * 1000;
  const match = /^(\d+(?:\.\d+)?)([dhms])$/.exec(value);
  if (!match) throw new Error(`Invalid duration ${JSON.stringify(value)}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
};

/** A workflow made by {@link createWorkflow}; {@link serveMany} names it after its route. */
export interface InvokableWorkflow<TPayload = any, TResult = any> {
  options: ServeOptions<TPayload>;
  routeFunction: (context: WorkflowContext<TPayload>) => Promise<TResult>;
  workflowId?: string;
}

export interface InvokeSettings<TPayload = unknown> {
  body?: TPayload;
  flowControl?: FlowControl;
  headers?: Record<string, string>;
  retries?: number;
  workflow: InvokableWorkflow<TPayload>;
  workflowRunId?: string;
}

interface StepRuntime {
  envelope: WorkflowEnvelope;
  startedAt: number;
  steps: Map<string, string>;
  store: WorkflowStore;
}

const encode = (value: unknown) => JSON.stringify({ v: value });
const decode = <T>(stored: string): T => (JSON.parse(stored) as { v: T }).v;

/**
 * Upstash Workflow's context, run by this repository's runtime. Steps are
 * memoized by position and name: a later delivery of the same run replays a
 * completed step's result instead of running it again, so route code must
 * call its steps in a deterministic order, as with Upstash.
 */
export class WorkflowContext<TInitialPayload = unknown> {
  readonly headers: Headers;
  readonly requestPayload: TInitialPayload;
  readonly url: string;
  readonly workflowRunId: string;

  private readonly inFlight = new Set<Promise<unknown>>();
  private position = 0;
  private readonly runtime: StepRuntime;

  constructor(runtime: StepRuntime, requestPayload: TInitialPayload, headers: Headers) {
    this.runtime = runtime;
    this.requestPayload = requestPayload;
    this.headers = headers;
    this.url = runtime.envelope.workflow.url;
    this.workflowRunId = runtime.envelope.workflow.runId;
  }

  async run<TResult>(stepName: string, stepFunction: () => TResult | Promise<TResult>) {
    const key = this.nextKey(stepName);
    const stored = this.runtime.steps.get(key);
    if (stored !== undefined) return decode<TResult>(stored);

    const execution = (async () => {
      await this.assertNotCanceled();
      const value = await stepFunction();
      const encoded = encode(value);
      await this.runtime.store.saveStep(this.workflowRunId, key, encoded);
      this.runtime.steps.set(key, encoded);
      return decode<TResult>(encoded);
    })();
    const value = await this.track(execution);

    if (Date.now() - this.runtime.startedAt > DELIVERY_BUDGET_MS) throw new WorkflowAbort(stepName);
    return value;
  }

  async sleep(stepName: string, duration: Duration): Promise<void> {
    const key = this.nextKey(stepName);
    const stored = this.runtime.steps.get(key);
    const now = Date.now();
    if (stored === undefined) {
      const delayMs = durationMs(duration);
      await this.runtime.store.saveStep(this.workflowRunId, key, encode(now + delayMs));
      throw new WorkflowAbort(stepName, { delayMs });
    }
    const wakeAt = decode<number>(stored);
    if (now < wakeAt) throw new WorkflowAbort(stepName, { delayMs: wakeAt - now });
  }

  async sleepUntil(stepName: string, until: Date | number): Promise<void> {
    const at = typeof until === 'number' ? until : until.getTime();
    return this.sleep(stepName, Math.max(0, (at - Date.now()) / 1000));
  }

  /**
   * Runs another workflow served next to this one (`serveMany`) and waits for
   * it: this delivery ends, and the child resumes the run when it finishes.
   */
  async invoke<TResult = unknown, TPayload = unknown>(
    stepName: string,
    settings: InvokeSettings<TPayload>,
  ): Promise<InvokeResult<TResult>> {
    const key = this.nextKey(stepName);
    const stored = this.runtime.steps.get(key);
    if (stored !== undefined) return decode<InvokeResult<TResult>>(stored);

    const pendingKey = `#pending:${key}`;
    if (!this.runtime.steps.has(pendingKey)) {
      const { workflowId } = settings.workflow;
      if (!workflowId) throw new Error('context.invoke needs a workflow registered with serveMany');
      await this.assertNotCanceled();
      const { store } = this.runtime;
      await store.saveStep(this.workflowRunId, '#envelope', JSON.stringify(this.runtime.envelope));
      const childUrl = new URL(this.url);
      childUrl.pathname = childUrl.pathname.replace(/[^/]+\/?$/, workflowId);
      const { workflowRunId } = await triggerChild(
        {
          body: settings.body,
          flowControl: settings.flowControl,
          headers: settings.headers,
          retries: settings.retries,
          url: childUrl.toString(),
          workflowRunId: settings.workflowRunId,
        },
        { runId: this.workflowRunId, stepKey: key },
      );
      await store.saveStep(this.workflowRunId, pendingKey, JSON.stringify(workflowRunId));
    }
    throw new WorkflowAbort(stepName, { waitForChild: true });
  }

  /** Waits for every step this delivery started, so none outlives the delivery. */
  async settle() {
    while (this.inFlight.size > 0) await Promise.allSettled(this.inFlight);
  }

  private async assertNotCanceled() {
    if ((await this.runtime.store.getStatus(this.workflowRunId)) === 'canceled')
      throw new WorkflowCanceled(this.workflowRunId);
  }

  private nextKey(stepName: string) {
    this.position += 1;
    return `${this.position}:${stepName}`;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    const forget = () => this.inFlight.delete(promise);
    promise.then(forget, forget);
    return promise;
  }
}

export interface FailureFunctionArgs<TPayload> {
  context: Pick<WorkflowContext<TPayload>, 'headers' | 'requestPayload' | 'workflowRunId'>;
  failHeaders: Record<string, string[]>;
  failResponse: string;
  failStatus: number;
}

export interface ServeOptions<TPayload = unknown> {
  /** Runs once when the run fails for good: retries spent or a non-retryable error. */
  failureFunction?: (args: FailureFunctionArgs<TPayload>) => Promise<unknown> | unknown;
  /** Applies to every delivery of the runs this route serves, on top of the trigger's own. */
  flowControl?: FlowControl;
  initialPayloadParser?: (raw: string) => TPayload;
}

const isEnvelope = (value: unknown): value is WorkflowEnvelope => {
  const workflow = (value as WorkflowEnvelope | undefined)?.workflow;
  return (
    !!workflow &&
    workflow.v === 1 &&
    typeof workflow.runId === 'string' &&
    typeof workflow.url === 'string' &&
    Number.isInteger(workflow.seq) &&
    Number.isInteger(workflow.retries)
  );
};

const rawPayload = (payload: unknown): string =>
  typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? '');

const parseDefault = (raw: string): unknown => {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const nonRetryable = (c: Context, error: string, status: number) =>
  c.json({ error }, status as 400, { 'Upstash-NonRetryable-Error': 'true' });

/** Holds the flow-control slots and rate a delivery needs, or reports how long to wait. */
const acquireFlowControl = async (
  store: WorkflowStore,
  controls: FlowControl[],
  token: string,
): Promise<{ held: string[]; waitMs: number }> => {
  const held: string[] = [];
  for (const control of controls) {
    if (control.parallelism) {
      if (!(await store.acquireSlot(control.key, token, control.parallelism, LEASE_MS)))
        return { held, waitMs: THROTTLE_RETRY_MS };
      held.push(control.key);
    }
    const rate = control.rate ?? control.ratePerSecond;
    if (rate) {
      const periodMs = control.rate && control.period ? durationMs(control.period) : 1000;
      const waitMs = await store.takeRate(control.key, rate, periodMs);
      if (waitMs > 0) return { held, waitMs };
    }
  }
  return { held, waitMs: 0 };
};

/** Tells the run that invoked this one how it ended, and resumes it. */
const reportToParent = async (
  store: WorkflowStore,
  envelope: WorkflowEnvelope,
  result: InvokeResult,
) => {
  const { parent } = envelope.workflow;
  if (!parent) return;
  const stored = await store.getStep(parent.runId, '#envelope');
  if (!stored) {
    console.error(
      '[workflow] parent %s of %s has no envelope',
      parent.runId,
      envelope.workflow.runId,
    );
    return;
  }
  await store.saveStep(parent.runId, parent.stepKey, encode(result));
  const parentEnvelope = JSON.parse(stored) as WorkflowEnvelope;
  await publishEnvelope({
    ...parentEnvelope,
    workflow: { ...parentEnvelope.workflow, seq: parentEnvelope.workflow.seq + 1 },
  });
};

const handle = async <TPayload, TResult>(
  c: Context,
  routeFunction: (context: WorkflowContext<TPayload>) => Promise<TResult>,
  options: ServeOptions<TPayload>,
): Promise<Response> => {
  const raw = await c.req.text();
  if (getDeliverySigningKey() && !verifyDeliveryRequest(c.req.raw, raw))
    return c.json({ error: 'Invalid signature' }, 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isEnvelope(parsed)) return nonRetryable(c, 'Not a workflow delivery', 400);
  const envelope: WorkflowEnvelope = parsed;

  const { runId } = envelope.workflow;
  const attempt = Number(c.req.header('Upstash-Retried') ?? 0);
  const store = getWorkflowStore();

  const status = await store.getStatus(runId);
  if (status) return c.json({ runId, status });

  const token = randomUUID();
  if (!(await store.acquireLock(runId, token, LEASE_MS)))
    return c.json({ runId, status: 'busy' }, 409, {
      'Retry-After': String(Math.ceil(LEASE_MS / 1000)),
    });

  let held: string[] = [];
  const renew = setInterval(() => {
    void store.renewLock(runId, token, LEASE_MS).catch(() => {});
    for (const key of held) void store.renewSlot(key, token, LEASE_MS).catch(() => {});
  }, RENEW_EVERY_MS);
  renew.unref?.();

  const continueLater = async (delayMs: number) =>
    publishEnvelope(
      { ...envelope, workflow: { ...envelope.workflow, seq: envelope.workflow.seq + 1 } },
      delayMs > 0 ? Math.ceil(delayMs / 1000) : undefined,
    );

  let context: WorkflowContext<TPayload> | undefined;
  const payloadText = rawPayload(envelope.payload);
  try {
    const controls = [envelope.workflow.flowControl, options.flowControl].filter(
      (control): control is FlowControl => !!control,
    );
    const flow = await acquireFlowControl(store, controls, token);
    held = flow.held;
    if (flow.waitMs > 0) {
      await continueLater(flow.waitMs);
      return c.json({ runId, status: 'throttled' }, 202);
    }

    const steps = await store.loadSteps(runId);
    let payload: TPayload;
    try {
      payload = options.initialPayloadParser
        ? options.initialPayloadParser(payloadText)
        : (parseDefault(payloadText) as TPayload);
    } catch (error) {
      throw new WorkflowNonRetryableError(
        `Invalid workflow payload: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    context = new WorkflowContext<TPayload>(
      { envelope, startedAt: Date.now(), steps, store },
      payload,
      c.req.raw.headers,
    );

    let result: TResult;
    try {
      result = await routeFunction(context);
    } finally {
      await context.settle();
    }

    await store.setStatus(runId, 'done');
    await reportToParent(store, envelope, { body: result, isCanceled: false, isFailed: false });
    return c.json({ runId, status: 'done' });
  } catch (error) {
    if (error instanceof WorkflowAbort) {
      if (!error.waitForChild) await continueLater(error.delayMs);
      return c.json({ runId, status: 'suspended', step: error.stepName }, 202);
    }
    if (error instanceof WorkflowCanceled) {
      await reportToParent(store, envelope, { body: undefined, isCanceled: true, isFailed: false });
      return c.json({ runId, status: 'canceled' });
    }

    const message = error instanceof Error ? error.message : String(error);
    const final =
      error instanceof WorkflowNonRetryableError || attempt >= envelope.workflow.retries;
    if (!final) {
      log('run %s attempt %d failed: %O', runId, attempt, error);
      return c.json({ error: message, runId }, 500);
    }

    console.error('[workflow] run %s at %s failed for good:', runId, envelope.workflow.url, error);
    if (options.failureFunction) {
      try {
        await options.failureFunction({
          context: context ?? {
            headers: c.req.raw.headers,
            requestPayload: parseDefault(payloadText) as TPayload,
            workflowRunId: runId,
          },
          failHeaders: {},
          failResponse: message,
          failStatus: 500,
        });
      } catch (failureError) {
        console.error('[workflow] failure function of run %s threw:', runId, failureError);
      }
    }
    await store.setStatus(runId, 'failed');
    await reportToParent(store, envelope, { body: undefined, isCanceled: false, isFailed: true });
    return c.json({ error: message, runId, status: 'failed' });
  } finally {
    clearInterval(renew);
    await Promise.allSettled([
      store.releaseLock(runId, token),
      ...held.map((key) => store.releaseSlot(key, token)),
    ]);
  }
};

/** Serves one workflow route, as `@upstash/workflow/hono`'s `serve` did. */
export const serve =
  <TPayload = unknown, TResult = unknown>(
    routeFunction: (context: WorkflowContext<TPayload>) => Promise<TResult>,
    options: ServeOptions<TPayload> = {},
  ) =>
  (c: Context) =>
    handle(c, routeFunction, options);

export const createWorkflow = <TPayload = unknown, TResult = unknown>(
  routeFunction: (context: WorkflowContext<TPayload>) => Promise<TResult>,
  options: ServeOptions<TPayload> = {},
): InvokableWorkflow<TPayload, TResult> => ({ options, routeFunction });

/** Serves several workflows on `/:workflowId`; each becomes invokable by its key. */
export const serveMany = (workflows: Record<string, InvokableWorkflow>) => {
  for (const [workflowId, workflow] of Object.entries(workflows)) workflow.workflowId = workflowId;
  return async (c: Context): Promise<Response> => {
    const workflow = workflows[c.req.param('workflowId') ?? ''];
    if (!workflow) return c.json({ error: 'Unknown workflow' }, 404);
    return handle(c, workflow.routeFunction, workflow.options);
  };
};

export type { TriggerOptions };
