import { format, inspect } from 'node:util';

import { expect, vi } from 'vitest';

/** Fake values standing in for credentials that must never reach any log sink. */
export const SENTINELS = {
  challenge: 'SENTINEL_CHALLENGE_c0ffee',
  code: 'SENTINEL_CODE_c0ffee',
  cookie: 'SENTINEL_COOKIE_c0ffee',
  grant: 'SENTINEL_GRANT_c0ffee',
  handoff: 'SENTINEL_HANDOFF_c0ffee',
  resume: 'SENTINEL_RESUME_c0ffee',
  state: 'SENTINEL_STATE_c0ffee',
  token: 'SENTINEL_TOKEN_c0ffee',
  uid: 'SENTINEL_UID_c0ffee',
} as const;

const sink: string[] = [];

/** Every `debug` namespace is enabled and collected, whatever `DEBUG` says. */
export const debugMock = {
  default:
    () =>
    (...args: unknown[]) => {
      sink.push(format(...args));
      // Also keep the raw arguments, in case a format specifier would have hidden them.
      for (const arg of args) if (typeof arg !== 'string') sink.push(inspect(arg, { depth: null }));
    },
};

const consoleMethods = ['debug', 'error', 'info', 'log', 'warn'] as const;

export const startLogCapture = () => {
  sink.length = 0;
  for (const method of consoleMethods)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      sink.push(
        args
          .map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: null })))
          .join(' '),
      );
    });
};

export const stopLogCapture = () => {
  for (const method of consoleMethods) vi.mocked(console[method]).mockRestore();
};

export const capturedLogs = () => sink.join('\n');

export const expectNoSecretsLogged = (secrets: readonly string[] = Object.values(SENTINELS)) => {
  const logs = capturedLogs();
  for (const secret of secrets) expect(logs, `log leaked ${secret}`).not.toContain(secret);
};
