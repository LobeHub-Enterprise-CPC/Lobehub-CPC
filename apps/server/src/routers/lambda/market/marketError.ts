import { getMarketErrorKind, MarketAPIError, type MarketErrorKind } from '@lobehub/market-sdk';
import { TRPCError } from '@trpc/server';

import { MARKET_IDENTITY_ERROR_PREFIX } from '@/libs/swr/normalizeError';

/**
 * Note the deliberate absence of `401`.
 *
 * `UNAUTHORIZED` is not an inert status code here — it drives re-authentication
 * UI. `createResponseMeta` tags any `UNAUTHORIZED` whose message isn't the
 * `MARKET_AUTH_REQUIRED_MESSAGE` sentinel with `X-Auth-Required`, and the
 * desktop proxy opens the LobeHub re-login prompt on that header. Mapping an
 * upstream 401 through would therefore ask the user to re-sign into LobeHub
 * because *Market* rejected a credential.
 *
 * These routers authenticate with the server's trusted-client token. A 401 means
 * that server credential is broken — a misconfiguration the user cannot fix by
 * signing in anywhere. So it stays a 500, which is what it is: our problem, not
 * theirs. It is still a failure the caller sees; nothing turns it into a success.
 */
const MARKET_KIND_TO_TRPC_CODE: Partial<Record<MarketErrorKind, TRPCError['code']>> = {
  forbidden: 'FORBIDDEN',
  invalid_input: 'BAD_REQUEST',
  not_found: 'NOT_FOUND',
  rate_limited: 'TOO_MANY_REQUESTS',
};

/**
 * `unavailable` covers every 5xx as well as a broken connection or a timeout.
 * Only Market's own "not ready" (503) is passed on as SERVICE_UNAVAILABLE; any
 * other server failure, and `unauthenticated` / `conflict` / `unknown`, stays a
 * 500 as it always has.
 */
const toTrpcCode = (error: MarketAPIError): TRPCError['code'] => {
  const kind = getMarketErrorKind(error);
  if (kind === 'unavailable') {
    return error.status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_SERVER_ERROR';
  }
  return MARKET_KIND_TO_TRPC_CODE[kind] ?? 'INTERNAL_SERVER_ERROR';
};

/**
 * Preserve the upstream Market status instead of collapsing everything into a
 * blanket 500.
 *
 * This matters most for `429`: Market rate limits these endpoints, and a client
 * that only sees `INTERNAL_SERVER_ERROR` cannot tell a transient throttle from a
 * real outage — so it retries with exponential backoff, and those retries land
 * inside the same rate-limit window and keep the bucket empty. And for `403` /
 * `404` / `503` of a resource whose rights Market decides: the caller must be
 * able to tell "you may not", "it is not there" and "Market is not ready" from
 * each other instead of reading all of them as "not found".
 */
export function mapMarketError(
  error: unknown,
  fallbackMessage: string,
  { exposeMessage = false }: { exposeMessage?: boolean } = {},
): TRPCError {
  // Already decided further in (an identity failure, a permission check).
  if (error instanceof TRPCError) return error;

  if (error instanceof MarketAPIError) {
    return new TRPCError({
      cause: error,
      code: toTrpcCode(error),
      message: error.message || fallbackMessage,
    });
  }

  return new TRPCError({
    cause: error,
    code: 'INTERNAL_SERVER_ERROR',
    // The message of an error that is not Market's own can be anything; it only
    // goes to the client when the caller says so, or when it is the identity
    // failure the client has a dedicated message for.
    message:
      error instanceof Error &&
      error.message &&
      (exposeMessage || error.message.startsWith(MARKET_IDENTITY_ERROR_PREFIX))
        ? error.message
        : fallbackMessage,
  });
}

/** Market answered that the resource is not in the requester's scope. Nothing else is "not found". */
export const isMarketNotFound = (error: unknown): boolean =>
  error instanceof MarketAPIError && getMarketErrorKind(error) === 'not_found';
