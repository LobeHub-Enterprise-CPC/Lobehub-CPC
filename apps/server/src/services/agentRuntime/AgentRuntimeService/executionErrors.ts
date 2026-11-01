/**
 * Infrastructure failures of the Hatchet delivery path. They mean "this attempt
 * must not run or commit the step", never that the operation failed: `failStep`
 * rethrows them untouched, and the step handler answers with a retryable
 * status so the delivery comes back.
 */

/** The step lock could not be read or written, so nobody knows who owns the operation. */
export class StepLockUnavailableError extends Error {
  constructor(
    public readonly operationId: string,
    options?: { cause?: unknown },
  ) {
    super(`Step lock unavailable for operation ${operationId}`, options);
    this.name = 'StepLockUnavailableError';
  }
}

/** The lock was lost (or could not be confirmed) before the step result was saved. */
export class StepOwnershipLostError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly stepIndex: number,
    options?: { cause?: unknown },
  ) {
    super(`Step ${stepIndex} of operation ${operationId} lost its lock before commit`, options);
    this.name = 'StepOwnershipLostError';
  }
}

/** A parked run's expiry check could not be armed: the delivery comes back to arm it. */
export class ClientWaitExpiryUnarmedError extends Error {
  constructor(
    public readonly operationId: string,
    options?: { cause?: unknown },
  ) {
    super(`Client wait expiry of operation ${operationId} could not be armed`, options);
    this.name = 'ClientWaitExpiryUnarmedError';
  }
}
