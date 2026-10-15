const CONTROLLED = /^[\w.:-]{1,64}$/;

const controlled = (value: unknown): string | undefined =>
  typeof value === 'number' || (typeof value === 'string' && CONTROLLED.test(value))
    ? String(value)
    : undefined;

/**
 * Describe a failure for the OIDC logs without its text.
 *
 * Error messages, stacks and attached payloads of this flow are not safe to print: a database
 * error embeds the query parameters (authorization codes, state, handoff ids), and
 * oidc-provider / jose errors can carry the request or token claims. Only the error class and
 * machine-readable codes are kept: `name`, `code`, the OAuth `error`, an HTTP status, and the
 * same codes of the direct `cause`.
 */
export const describeError = (error: unknown): string => {
  if (!error || typeof error !== 'object') return typeof error;

  const parts = new Set<string>();
  for (const source of [error, (error as { cause?: unknown }).cause]) {
    if (!source || typeof source !== 'object') continue;
    const { code, error: oauthError, name, status, statusCode } = source as Record<string, unknown>;
    for (const value of [name, code, oauthError, status ?? statusCode]) {
      const safe = controlled(value);
      if (safe) parts.add(safe);
    }
  }

  return parts.size > 0 ? [...parts].join(' ') : 'unknown error';
};
