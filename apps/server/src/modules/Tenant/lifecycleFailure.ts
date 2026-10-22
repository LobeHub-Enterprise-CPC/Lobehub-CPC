/**
 * Why a lifecycle event failed (`errorCode` of a failed result). Admin returns the same codes and
 * Console maps them to operator guidance (docs/tenant-control-plane.md). `action_required` needs
 * an operator before a retry can succeed: a failed POST answers it with 409, the rest with 503.
 * Must match contracts/tenant-control-plane/lifecycle-failure-codes.json (owned by Console, copied
 * byte-identically here); a unit test binds this table to it.
 */
export const LIFECYCLE_FAILURE_CODES = {
  LIFECYCLE_DRAIN_FAILED: 'retryable',
  LIFECYCLE_FAILED: 'retryable',
  LIFECYCLE_RESUME_FAILED: 'retryable',
  LIFECYCLE_STOP_FAILED: 'retryable',
  LIFECYCLE_STOP_UNCONFIRMED: 'retryable',
  TENANT_NOT_READY: 'retryable',
} as const;
export type LifecycleFailureCode = keyof typeof LIFECYCLE_FAILURE_CODES;
export const isActionRequired = (code: string | null | undefined) =>
  !!code && (LIFECYCLE_FAILURE_CODES as Record<string, string>)[code] === 'action_required';

/** A lifecycle phase that failed for a known reason; recorded on the event, never as text. */
export class LifecycleFailure extends Error {
  constructor(readonly code: LifecycleFailureCode) {
    super(code);
    this.name = 'LifecycleFailure';
  }
}
