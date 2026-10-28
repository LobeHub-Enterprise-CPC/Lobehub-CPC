import {
  buildTelemetryEventId,
  type CompletedTelemetryExecution,
  type TelemetryExecutionIdentity,
} from './event';
import { redactTelemetryText } from './redact';

export interface MonotonicClock {
  /** Milliseconds from an arbitrary origin; never goes back with the wall clock. */
  now: () => number;
}

export interface TelemetryOutcome {
  errorCode?: string;
  errorMessage?: string;
  /** The result said it is an error (an MCP `isError`), whatever else it says. */
  isError?: boolean;
  success?: boolean;
  /** The execution threw. */
  thrown?: unknown;
}

export interface TelemetryExecution {
  /** Fixes success, duration and time. The first call wins; later calls return it. */
  complete: (outcome?: TelemetryOutcome) => CompletedTelemetryExecution;
  /** Fixed at start: the execution identity does not depend on how it ends. */
  readonly eventId: string;
}

export interface StartTelemetryExecutionDeps {
  clock?: MonotonicClock;
  now?: () => Date;
}

const defaultClock: MonotonicClock = { now: () => performance.now() };

const thrownMessage = (thrown: unknown): string | undefined => {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === 'string') return thrown;
  const message = (thrown as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
};

const thrownCode = (thrown: unknown): string | undefined => {
  const code = (thrown as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[\w.:-]{1,100}$/.test(code) ? code : undefined;
};

/**
 * The shared execution-completion boundary. Every path that reports an
 * execution (cloud, http, stdio, device, the background runtime, a client
 * action) starts one of these before it runs and completes it exactly where
 * the outcome becomes known:
 *
 * - the `eventId` is derived from the execution's own identity and the
 *   scheduler's attempt number, never from time or a retry of the report;
 * - success, duration and `occurredAt` are fixed here, once, so a report that
 *   is retried carries the very same facts.
 *
 * success is false when the result says so (`success: false`, `isError`) or the
 * execution threw.
 */
export const startTelemetryExecution = (
  identity: TelemetryExecutionIdentity,
  { clock = defaultClock, now = () => new Date() }: StartTelemetryExecutionDeps = {},
): TelemetryExecution => {
  const eventId = buildTelemetryEventId(identity);
  const startedAt = clock.now();
  let completed: CompletedTelemetryExecution | undefined;

  return {
    complete: (outcome = {}) => {
      if (completed) return completed;

      const threw = outcome.thrown !== undefined;
      const success = !threw && outcome.isError !== true && outcome.success !== false;
      const message = outcome.errorMessage ?? (threw ? thrownMessage(outcome.thrown) : undefined);

      completed = Object.freeze({
        attempt: identity.attempt,
        durationMs: Math.max(0, Math.round(clock.now() - startedAt)),
        ...(success
          ? {}
          : {
              errorCode:
                outcome.errorCode ??
                (threw ? thrownCode(outcome.thrown) : undefined) ??
                'CALL_FAILED',
              ...(message ? { errorMessage: redactTelemetryText(message) } : {}),
            }),
        eventId,
        eventType: identity.eventType,
        occurredAt: now().toISOString(),
        success,
      });

      return completed;
    },
    eventId,
  };
};

/**
 * What a tool result says about its own outcome, through the envelopes that
 * wrap it: the MCP client returns `{ content, state: { isError }, success }`
 * and the executor nests that once more under `state`. Only an explicit
 * `success: false` or `isError: true` counts.
 */
export const inspectToolResultOutcome = (
  result: unknown,
): Pick<TelemetryOutcome, 'isError' | 'success'> => {
  const outcome: Pick<TelemetryOutcome, 'isError' | 'success'> = {};

  let layer: unknown = result;
  for (let depth = 0; depth < 4 && layer && typeof layer === 'object'; depth++) {
    const { isError, state, success } = layer as {
      isError?: unknown;
      state?: unknown;
      success?: unknown;
    };
    if (isError === true) outcome.isError = true;
    if (success === false) outcome.success = false;
    layer = state;
  }

  return outcome;
};
