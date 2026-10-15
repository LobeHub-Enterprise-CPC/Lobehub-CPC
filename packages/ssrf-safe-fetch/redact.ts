/**
 * Credential-safe views of URLs, text and errors for logs and thrown messages.
 *
 * Lives in this package because every failed outbound request (`Fetch failed:
 * request to <url> failed ...`) echoes the full URL, whose userinfo and query
 * string routinely carry API keys. It is dependency-free so both the Node and
 * browser entry points, and other packages, can share one implementation.
 */

export const REDACTED = '[REDACTED]';

/** Secrets shorter than this are not scrubbed from free text (too many false hits). */
const MIN_SECRET_LENGTH = 4;
const MAX_ERROR_DEPTH = 6;
// `[REDACTED]` is matched as one atom so a URL that was already sanitized is
// recognised whole and is not cut at the marker's brackets.
const URL_IN_TEXT = /[a-z][\d+.a-z-]*:\/\/(?:\[REDACTED\]|[^\s"'<>`])+/gi;
const MARKER_SENTINEL = '\u0000';
const TRAILING_SENTENCE_PUNCTUATION = new Set(['!', ',', '.', ':', ';', '?']);
const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const AUTH_SCHEME_PREFIX = /^(?:bearer|basic|token)\s+/i;

/**
 * Drop URL userinfo and fragment and mask query values; keep scheme, host, port,
 * path and query parameter names for diagnostics. Unparseable input is replaced
 * entirely (it may be a bare token).
 */
export const sanitizeUrlForLogging = (raw: string): string => {
  try {
    const url = new URL(raw);
    const query = [...new Set(url.searchParams.keys())]
      .map((key) => `${encodeURIComponent(key)}=${REDACTED}`)
      .join('&');
    return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return `[invalid-url ${REDACTED}]`;
  }
};

/**
 * Split trailing sentence punctuation / unbalanced closing brackets off a URL
 * candidate found in prose (`see (https://x/y).`). Brackets that pair up inside
 * the candidate (IPv6 hosts, the `[REDACTED]` marker) stay part of the URL.
 */
const splitTrailingPunctuation = (candidate: string): [url: string, trailing: string] => {
  // The marker is atomic: hide its brackets from the balance check.
  let url = candidate.replaceAll(REDACTED, MARKER_SENTINEL);
  let trailing = '';

  while (url.length > 0) {
    const last = url.at(-1)!;
    const opener = CLOSER_TO_OPENER[last];
    const strip =
      TRAILING_SENTENCE_PUNCTUATION.has(last) ||
      (opener !== undefined &&
        [...url].filter((c) => c === last).length > [...url].filter((c) => c === opener).length);
    if (!strip) break;
    trailing = last + trailing;
    url = url.slice(0, -1);
  }

  return [
    url.replaceAll(MARKER_SENTINEL, REDACTED),
    trailing.replaceAll(MARKER_SENTINEL, REDACTED),
  ];
};

/**
 * Replace every URL found in free text with its sanitized form. Idempotent:
 * text that was already sanitized comes back unchanged.
 */
export const redactUrlsInText = (text: string): string =>
  text.replaceAll(URL_IN_TEXT, (match) => {
    const [candidate, trailing] = splitTrailingPunctuation(match);
    const scheme = candidate.split('://')[0];
    if (candidate === `${scheme}://${REDACTED}`) return match;

    const sanitized = sanitizeUrlForLogging(candidate);
    return `${sanitized.startsWith('[') ? `${scheme}://${REDACTED}` : sanitized}${trailing}`;
  });

/**
 * Expand secret values into the forms in which they may appear in messages:
 * raw, URL-encoded, and without an `Authorization` scheme prefix.
 */
export const expandSecrets = (values: Iterable<string | undefined | null>): string[] => {
  const out = new Set<string>();

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const variants = [value, value.replace(AUTH_SCHEME_PREFIX, ''), encodeURIComponent(value)];
    for (const variant of variants) {
      // a fragment of the marker itself would re-wrap already-redacted text
      if (variant.length >= MIN_SECRET_LENGTH && !REDACTED.includes(variant)) out.add(variant);
    }
  }

  // Longest first so a secret that contains another one is replaced whole.
  return [...out].sort((a, b) => b.length - a.length);
};

/** Replace every occurrence of the given secret values in text. */
export const redactSecretValues = (text: string, secrets: readonly string[]): string => {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Build a fresh, log-safe copy of an error (and its `cause` chain): known secret
 * values and URL credentials are removed from message, stack and own string
 * properties. The original (possibly third-party) error is never mutated.
 * Own primitive fields such as `code` / `errno` / `type` and plain-object fields
 * such as `data` are kept so callers can still branch on them.
 */
export const sanitizeErrorForLogging = (
  error: unknown,
  secrets: Iterable<string | undefined | null> = [],
): Error => {
  const expanded = expandSecrets(secrets);
  const clean = (text: string) => redactUrlsInText(redactSecretValues(text, expanded));

  const cleanValue = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return clean(value);
    if (depth > MAX_ERROR_DEPTH) return undefined;
    if (Array.isArray(value)) return value.map((item) => cleanValue(item, depth + 1));
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cleanValue(item, depth + 1)]),
      );
    }
    if (value === null || ['boolean', 'number', 'undefined'].includes(typeof value)) return value;
    return undefined;
  };

  const sanitize = (input: unknown, depth: number): Error => {
    if (!(input instanceof Error)) {
      return new Error(clean(input instanceof Object ? '[non-error value]' : String(input)));
    }

    const copy = new Error(
      clean(input.message),
      depth < MAX_ERROR_DEPTH && input.cause !== undefined
        ? { cause: sanitize(input.cause, depth + 1) }
        : undefined,
    );
    copy.name = input.name;
    if (input.stack) copy.stack = clean(input.stack);

    for (const [key, value] of Object.entries(input)) {
      if (key === 'message' || key === 'stack' || key === 'cause' || key === 'name') continue;
      const cleaned = cleanValue(value, 0);
      if (cleaned !== undefined) (copy as any)[key] = cleaned;
    }

    return copy;
  };

  return sanitize(error, 0);
};
