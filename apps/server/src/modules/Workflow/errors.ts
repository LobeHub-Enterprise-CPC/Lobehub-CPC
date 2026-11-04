/**
 * Thrown by the runtime to end the current delivery early: the run continues
 * in a later delivery (after `delayMs`), or, while it waits for an invoked
 * child, when that child reports back. Route code must let it propagate.
 */
export class WorkflowAbort extends Error {
  readonly delayMs: number;
  readonly stepName: string;
  /** The run resumes when an invoked child finishes, not on a timer. */
  readonly waitForChild: boolean;

  constructor(stepName: string, options: { delayMs?: number; waitForChild?: boolean } = {}) {
    super(`Workflow suspended at step ${stepName}`);
    this.name = 'WorkflowAbort';
    this.stepName = stepName;
    this.delayMs = options.delayMs ?? 0;
    this.waitForChild = options.waitForChild ?? false;
  }
}

/** Fails the run at once: no retry, the failure function runs. */
export class WorkflowNonRetryableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'WorkflowNonRetryableError';
  }
}

/** The run was canceled while this delivery executed it. */
export class WorkflowCanceled extends Error {
  constructor(runId: string) {
    super(`Workflow run ${runId} was canceled`);
    this.name = 'WorkflowCanceled';
  }
}
