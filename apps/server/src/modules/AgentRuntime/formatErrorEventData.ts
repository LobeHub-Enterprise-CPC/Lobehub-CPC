import { ModelEmptyError, ModelRefusalError } from '@lobechat/model-runtime';
import { pickNonEmptyString, toRecord } from '@lobechat/utils/object';
import { DATABASE_ERROR_PUBLIC_MESSAGE, toPublicErrorText } from '@lobechat/utils/queryError';

import { formatErrorForState, logInternalError } from './formatErrorForState';
import { pgErrorType, unwrapPgError } from './pgError';

const isErrorType = (value: unknown): value is string | number =>
  typeof value === 'string' || typeof value === 'number';

/**
 * Normalize an arbitrary thrown value into the shape the runtime stream-event
 * protocol expects. Extracts a human-readable `error` string and a best-effort
 * `errorType` bucket key.
 *
 * Precedence:
 *   1. Business-typed errors that carry an `errorType` string on the error
 *      object itself (e.g. `ConversationParentMissing`) — kept as-is with
 *      their original message. These already mean something specific and
 *      must not be reclassified.
 *   2. PostgreSQL errors — detected anywhere in the `.cause` chain OR at the
 *      top level (driver classes like `PostgresError` / `DatabaseError`
 *      carry their own `name` but no business-typed `errorType`). Emitted as
 *      `pg_<sqlstate>` with a generic message; SQL and driver detail stay in
 *      server logs, since the client shows this event on the message.
 *   3. Anything else — falls back to `error.message` + `error.name`, or
 *      `"Unknown error"` when the value isn't even an Error.
 *
 * See for the motivation: Drizzle wraps driver errors
 * as `"Failed query: insert into ..."` and buries the real diagnostic fields
 * under `.cause`, which left the agent-gateway dashboard unable to bucket
 * DB failures by SQLSTATE.
 */
export const formatErrorEventData = (error: unknown, phase: string) => {
  const payload = toRecord(error);
  const rawPayloadErrorType = payload?.errorType ?? payload?.type;
  const payloadErrorType = isErrorType(rawPayloadErrorType) ? rawPayloadErrorType : undefined;
  /**
   * Runtime completion errors and provider chat errors thrown as Error instances (e.g. a
   * `StreamChunkError` raised while consuming the model stream) carry their provider,
   * diagnostics, and trace id on the instance. Keep that body so the client can persist it
   * and render provider-specific error UI; other Error instances keep the flat shape.
   */
  const isRuntimeCompletionError =
    error instanceof ModelEmptyError ||
    error instanceof ModelRefusalError ||
    (error instanceof Error &&
      payloadErrorType !== undefined &&
      pickNonEmptyString(payload?.provider) !== undefined);
  const structuredError = isRuntimeCompletionError
    ? formatErrorForState(error)
    : error instanceof Error || payloadErrorType === undefined
      ? undefined
      : formatErrorForState(payload);
  const body = structuredError?.body;
  const hasPayloadErrorType = payloadErrorType !== undefined;
  let errorType = hasPayloadErrorType
    ? String(structuredError?.type ?? payloadErrorType)
    : undefined;
  const payloadError = payload?.error;
  let errorMessage =
    pickNonEmptyString(structuredError?.message) ??
    pickNonEmptyString(payload?.message) ??
    pickNonEmptyString(payloadError) ??
    pickNonEmptyString(toRecord(payloadError)?.message) ??
    (error instanceof Error ? pickNonEmptyString(error.message) : pickNonEmptyString(error)) ??
    errorType ??
    'Unknown error';

  if (!errorType && error instanceof Error && error.name) {
    errorType = error.name;
  }

  // Enrichment: run PG unwrap whenever no payload errorType was
  // declared. This covers both Drizzle-wrapped errors (PG info under .cause)
  // AND raw top-level driver errors like `PostgresError` / `DatabaseError`
  // which carry a specific `name` but are still real PG errors deserving
  // `pg_<sqlstate>` classification on the dashboard.
  if (!hasPayloadErrorType) {
    const pg = unwrapPgError(error);
    if (pg) {
      errorMessage = DATABASE_ERROR_PUBLIC_MESSAGE;
      errorType = pgErrorType(pg);
      if (error instanceof Error) logInternalError(error, errorType, pg);
    }
  }

  const publicMessage = toPublicErrorText(errorMessage);
  if (publicMessage !== errorMessage && error instanceof Error) logInternalError(error, errorType);

  return {
    ...(body === undefined ? {} : { body }),
    // The client overlays this onto the visible message.
    error: publicMessage,
    errorType,
    phase,
  };
};
