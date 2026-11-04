/** Upstash-style flow control: bounds how many runs sharing `key` execute at once, and how often they start. */
export interface FlowControl {
  key: string;
  /** Runs holding a slot of this key at the same time. */
  parallelism?: number;
  /** Rate window: seconds, or a duration such as `30s`, `5m`, `1h`, `1d`. */
  period?: number | `${number}${'d' | 'h' | 'm' | 's'}`;
  /** Starts allowed per `period` (default one second). */
  rate?: number;
  /** Older spelling of `rate` per one second. */
  ratePerSecond?: number;
}

/** Where a child run reports back to the run that invoked it. */
export interface WorkflowParent {
  runId: string;
  /** The invoking step's key in the parent run. */
  stepKey: string;
}

/**
 * What every delivery of a workflow run carries. Continuations repeat it with
 * a higher `seq`; step results live in the workflow store, not in here.
 */
export interface WorkflowEnvelope {
  /** Forwarded to the route on every delivery (trace context and the like). */
  headers?: Record<string, string>;
  /** The trigger body, exactly as given. */
  payload: unknown;
  workflow: {
    flowControl?: FlowControl;
    parent?: WorkflowParent;
    /** Retries of one delivery after its first attempt. */
    retries: number;
    /** Retry backoff expression, as for a direct delivery. */
    retryDelay?: string;
    runId: string;
    /** 0 for the trigger, +1 for every continuation. */
    seq: number;
    /** Absolute address of the route serving this run. */
    url: string;
    v: 1;
  };
}

/** What `context.invoke` resolves to, as with Upstash Workflow. */
export interface InvokeResult<TBody = unknown> {
  body: TBody | undefined;
  isCanceled: boolean;
  isFailed: boolean;
}

export type WorkflowRunStatus = 'canceled' | 'done' | 'failed';
