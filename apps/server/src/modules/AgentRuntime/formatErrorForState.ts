import { normalizeHeterogeneousMessageError } from '@lobechat/heterogeneous-agents/errors';
import { normalizeChatMessageError } from '@lobechat/model-runtime/errors';
import type { ChatErrorBudgetContext, ChatMessageError } from '@lobechat/types';
import { isRecord } from '@lobechat/utils/object';
import { DATABASE_ERROR_PUBLIC_MESSAGE } from '@lobechat/utils/queryError';

import { type PgErrorInfo, pgErrorType, unwrapPgError } from './pgError';

const LOGGED_INTERNAL_ERRORS = new WeakSet<Error>();

/**
 * The stored error is user-visible, so an internal throw keeps its stack, SQL
 * and driver detail only here: one JSON line per thrown error (the runtime
 * re-normalizes the same error several times on its way to the message).
 */
export const logInternalError = (error: Error, type: unknown, pg?: PgErrorInfo) => {
  if (LOGGED_INTERNAL_ERRORS.has(error)) return;
  LOGGED_INTERNAL_ERRORS.add(error);
  const cause = (error as { cause?: unknown }).cause;
  console.error(
    JSON.stringify({
      cause:
        cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
      event: 'agent_runtime.internal_error',
      message: error.message,
      name: error.name,
      pg,
      stack: error.stack,
      type,
    }),
  );
};

/**
 * Normalize a thrown value into the stored `ChatMessageError`. Database errors
 * keep only their SQLSTATE bucket (`pg_<code>`) and a generic message.
 */
export const formatErrorForState = (error: unknown): ChatMessageError => {
  if (error instanceof Error) {
    const pg = unwrapPgError(error);
    if (pg) {
      const type = pgErrorType(pg) as ChatMessageError['type'];
      logInternalError(error, type, pg);
      return {
        attribution: 'harness',
        body: { name: error.name, pgCode: pg.code },
        category: 'stream',
        countAsFailure: true,
        httpStatus: 500,
        message: DATABASE_ERROR_PUBLIC_MESSAGE,
        retryable: false,
        severity: 'error',
        type,
      };
    }
  }
  const formatted = normalizeHeterogeneousMessageError(normalizeChatMessageError(error));
  if (error instanceof Error && formatted.attribution !== 'provider') {
    logInternalError(error, formatted.type);
  }
  return formatted;
};

const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Read the structured allowance context a cost-admission gate attached to a
 * rejected run out of an already-normalized error.
 *
 * `buildPayloadBody` copies the throw site's `budget` payload onto `body`
 * verbatim, and `body` is `any` — so narrow it field by field here instead of
 * casting. A field that isn't a finite number / string is dropped rather than
 * forwarded to a renderer that would print `undefined` at the user, and a
 * context with nothing usable left in it collapses to `undefined` so callers
 * can treat "no budget context" and "unusable budget context" the same way.
 */
export const readErrorBudgetContext = (
  error: ChatMessageError | undefined,
): ChatErrorBudgetContext | undefined => {
  const budget = (error?.body as { budget?: unknown } | undefined)?.budget;
  if (!isRecord(budget)) return undefined;

  const context: ChatErrorBudgetContext = {
    availableCredits: readFiniteNumber(budget.availableCredits),
    budgetTypeAtError:
      typeof budget.budgetTypeAtError === 'string' ? budget.budgetTypeAtError : undefined,
    requiredCredits: readFiniteNumber(budget.requiredCredits),
    shortfallCredits: readFiniteNumber(budget.shortfallCredits),
  };

  return Object.values(context).some((value) => value !== undefined) ? context : undefined;
};
