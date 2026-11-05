/**
 * Drizzle wraps every failed statement as `Failed query: <sql>\nparams: <values>`,
 * so the message carries the full SQL and its bound values (ids, message
 * content, …). That text is for server logs only: any copy that reaches a
 * stored message error, `tasks.error` or an API response ends up on screen.
 */
const QUERY_DETAIL_MARKER = 'Failed query:';

const MAX_CAUSE_DEPTH = 5;

/** Shown wherever a database failure would otherwise print its SQL. */
export const DATABASE_ERROR_PUBLIC_MESSAGE = 'A database operation failed. Please try again later.';

export const containsQueryDetail = (value: unknown): boolean =>
  typeof value === 'string' && value.includes(QUERY_DETAIL_MARKER);

/** Whether the error, or any error in its `.cause` chain, carries query detail. */
export const isQueryError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let i = 0; i < MAX_CAUSE_DEPTH && current && typeof current === 'object'; i++) {
    if (containsQueryDetail((current as { message?: unknown }).message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** The text to show for an error message, with query detail replaced. */
export const toPublicErrorText = <T extends string | null | undefined>(text: T): T =>
  (containsQueryDetail(text) ? DATABASE_ERROR_PUBLIC_MESSAGE : text) as T;
