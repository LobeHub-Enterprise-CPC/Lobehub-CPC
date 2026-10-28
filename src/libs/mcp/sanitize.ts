/**
 * Log-safe views of MCP connection parameters.
 *
 * MCP params carry credentials in several places (stdio `env`, HTTP `auth`
 * tokens, custom `headers`, URL userinfo/query, secret-looking CLI args). Every
 * log / console / debug call that mentions params MUST go through
 * {@link sanitizeMcpParamsForLogging} instead of printing the object directly.
 *
 * Redaction policy:
 * - `env`, `headers`: keys kept, every value masked.
 * - `auth`: only non-secret metadata kept (`type`, `scope`, `tokenExpiresAt`);
 *   every other defined field (tokens, client secret, ...) is masked.
 * - `url`: userinfo dropped, query values masked, fragment dropped. Path
 *   segments are kept (they are not reliably distinguishable from secrets).
 * - `args`: values of secret-looking flags (`--token x`, `--api-key=x`) and
 *   URL-shaped args are masked; other args are kept.
 * - any other key whose name looks credential-bearing (token, secret, password,
 *   authorization, api key, cookie, ...) is masked whole, at any depth.
 */

import {
  expandSecrets,
  REDACTED,
  redactSecretValues,
  redactUrlsInText,
  sanitizeErrorForLogging,
  sanitizeUrlForLogging,
} from '@lobechat/ssrf-safe-fetch';

export { REDACTED, sanitizeUrlForLogging };

const AUTH_PUBLIC_KEYS = new Set(['scope', 'tokenExpiresAt', 'type']);
const KEY_VALUE_MAP_KEYS = new Set(['env', 'headers']);
const SENSITIVE_NAME =
  /token|secret|passw(?:or)?d|pwd|credential|authorization|api[-_]?key|cookie|bearer|session[-_]?id|(?:^|[-_])key$/i;
const MAX_DEPTH = 8;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const mask = (value: unknown) => (value === undefined || value === null ? value : REDACTED);

const redactArgs = (args: unknown[]): unknown[] => {
  let maskNext = false;

  return args.map((arg) => {
    if (typeof arg !== 'string') return arg;

    if (maskNext) {
      maskNext = false;
      return REDACTED;
    }

    if (/^[a-z][\d+.a-z-]*:\/\//i.test(arg)) return sanitizeUrlForLogging(arg);

    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (SENSITIVE_NAME.test(name)) {
        if (eq === -1) {
          maskNext = true;
          return arg;
        }
        return `${name}=${REDACTED}`;
      }
    }

    return arg;
  });
};

const redactAuth = (auth: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(auth).map(([key, value]) => [
      key,
      AUTH_PUBLIC_KEYS.has(key) ? value : mask(value),
    ]),
  );

const redactValue = (key: string, value: unknown, depth: number): unknown => {
  if (value === undefined || value === null) return value;

  if (KEY_VALUE_MAP_KEYS.has(key) && isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]));
  }
  if (key === 'auth' && isPlainObject(value)) return redactAuth(value);
  if (key === 'url' && typeof value === 'string') return sanitizeUrlForLogging(value);
  if (key === 'args' && Array.isArray(value)) return redactArgs(value);
  if (SENSITIVE_NAME.test(key)) return REDACTED;

  return redactDeep(value, depth + 1);
};

const redactDeep = (value: unknown, depth: number): unknown => {
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactValue(key, item, depth)]),
  );
};

/**
 * Return a copy of MCP connection params (or any object embedding them, such
 * as marketplace deployment options) that is safe to print to logs.
 */
export const sanitizeMcpParamsForLogging = <T>(params: T): unknown => redactDeep(params, 0);

const collectUrlSecrets = (raw: string, out: string[]) => {
  try {
    const url = new URL(raw);
    out.push(
      url.username,
      url.password,
      decodeURIComponent(url.username),
      decodeURIComponent(url.password),
    );
    for (const value of url.searchParams.values()) out.push(value);
    // raw (still percent-encoded) query values as they appear in messages
    for (const pair of url.search.slice(1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq !== -1) out.push(pair.slice(eq + 1));
    }
  } catch {
    // unparseable: nothing structured to extract
  }
};

const collectArgSecrets = (args: unknown[], out: string[]) => {
  let maskNext = false;

  for (const arg of args) {
    if (typeof arg !== 'string') continue;

    if (maskNext) {
      maskNext = false;
      out.push(arg);
    } else if (/^[a-z][\d+.a-z-]*:\/\//i.test(arg)) {
      collectUrlSecrets(arg, out);
    } else if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (SENSITIVE_NAME.test(name)) {
        if (eq === -1) maskNext = true;
        else out.push(arg.slice(eq + 1));
      }
    }
  }
};

/**
 * Every secret value carried by MCP connection params: auth tokens / client
 * secret, header values, env values, URL userinfo and query values, and values
 * of secret-looking stdio flags. Used to scrub free-form error text, where the
 * structured redaction above cannot apply.
 */
export const collectMcpSecrets = (params: unknown): string[] => {
  const out: string[] = [];
  if (!isPlainObject(params)) return out;

  if (isPlainObject(params.auth)) {
    for (const [key, value] of Object.entries(params.auth)) {
      if (!AUTH_PUBLIC_KEYS.has(key) && typeof value === 'string') out.push(value);
    }
  }
  for (const mapKey of KEY_VALUE_MAP_KEYS) {
    const map = params[mapKey];
    if (!isPlainObject(map)) continue;
    for (const value of Object.values(map)) if (typeof value === 'string') out.push(value);
  }
  if (typeof params.url === 'string') collectUrlSecrets(params.url, out);
  if (Array.isArray(params.args)) collectArgSecrets(params.args, out);

  return out;
};

/** A fresh, log-safe copy of `error` (and its cause chain) for these MCP params. */
export const sanitizeErrorForMcp = (error: unknown, params: unknown): Error =>
  sanitizeErrorForLogging(error, collectMcpSecrets(params));

/** Scrub MCP param secrets and raw URLs from free-form text. */
export const redactMcpText = (text: string, params: unknown): string =>
  redactUrlsInText(redactSecretValues(text, expandSecrets(collectMcpSecrets(params))));
