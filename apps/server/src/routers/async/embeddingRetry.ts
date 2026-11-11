const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;

/**
 * The HTTP status behind an error, wherever the runtime left it: a numeric `status`, or
 * only the SDK's message, which starts with it (`504 upstream unreachable`).
 */
const statusOf = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const {
    error: inner,
    message,
    status,
  } = error as {
    error?: unknown;
    message?: unknown;
    status?: unknown;
  };
  if (typeof status === 'number') return status;
  const leading = typeof message === 'string' ? /^(\d{3})\b/.exec(message) : null;
  if (leading) return Number(leading[1]);
  return statusOf(inner);
};

/**
 * Whether an embedding request failed for a reason that passes on its own: the provider's
 * rate limit or a 5xx. Providers report the rate limit in different places (HTTP 429, an
 * error type, or only a code such as `ModelAccountTpmRateLimitExceeded` in the body), so
 * the whole error is searched.
 */
export const isTransientEmbeddingError = (error: unknown): boolean => {
  const status = statusOf(error);
  if (status === 429 || (status !== undefined && status >= 500)) return true;

  let text: string | undefined;
  try {
    // An Error serializes to `{}`: its message is not enumerable.
    text =
      error instanceof Error ? `${error.message} ${JSON.stringify(error)}` : JSON.stringify(error);
  } catch {
    return false;
  }
  return /rate.?limit|too.?many.?requests/i.test(text ?? '');
};

interface RetryOptions {
  /** Epoch ms after which no further attempt starts. */
  deadline: number;
  now?: () => number;
  /** Called before each wait, with the 1-based number of the attempt that failed. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `request`, backing off and trying again while it fails transiently. The wait
 * doubles from 2s up to a minute, the length of a per-minute quota window, with jitter
 * so the batches of a bulk import do not all return at once. Gives up with the last
 * error once the next wait would pass `deadline`.
 */
export const retryTransientEmbeddingError = async <T>(
  request: () => Promise<T>,
  {
    deadline,
    now = Date.now,
    onRetry,
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: RetryOptions,
): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!isTransientEmbeddingError(error)) throw error;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) * (0.5 + random() / 2);
      if (now() + delay >= deadline) throw error;
      onRetry?.({ attempt: attempt + 1, delayMs: Math.round(delay), error });
      await sleep(delay);
    }
  }
};
