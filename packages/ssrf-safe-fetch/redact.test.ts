import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  redactUrlsInText,
  sanitizeErrorForLogging,
  sanitizeUrlForLogging,
} from './redact';

describe('sanitizeUrlForLogging', () => {
  it('drops userinfo and fragment, masks query values, keeps host/port/path/param names', () => {
    expect(sanitizeUrlForLogging('https://u:p@h.example:8443/a/b?x=1&y=2#frag')).toBe(
      `https://h.example:8443/a/b?x=${REDACTED}&y=${REDACTED}`,
    );
  });

  it('does not echo unparseable input', () => {
    expect(sanitizeUrlForLogging('sk-secret-not-a-url')).not.toContain('sk-secret');
  });
});

describe('redactUrlsInText', () => {
  it('sanitizes every URL and keeps trailing punctuation outside of it', () => {
    expect(
      redactUrlsInText('GET https://a.example/p?k=SECRET1, then (http://u:SECRET2@b.example/).'),
    ).toBe(`GET https://a.example/p?k=${REDACTED}, then (http://b.example/).`);
  });

  it('never leaves an unparseable URL-looking token behind', () => {
    expect(redactUrlsInText('see https://[bad-SECRET')).not.toContain('SECRET');
  });
});

describe('sanitizeErrorForLogging', () => {
  it('scrubs secrets and URLs from message, stack, cause chain and own fields without mutating the input', () => {
    const inner = new Error('inner failed for https://h.example/?k=URLSECRET and TOKENSECRET');
    const original = Object.assign(new Error('outer TOKENSECRET', { cause: inner }), {
      code: 'ECONNRESET',
      data: { detail: 'header HEADERSECRET', nested: [1, 'TOKENSECRET'] },
    });
    const before = original.message;

    const safe: any = sanitizeErrorForLogging(original, ['TOKENSECRET', 'Bearer HEADERSECRET']);

    const text = JSON.stringify([
      safe.message,
      safe.stack,
      safe.data,
      safe.cause.message,
      safe.cause.stack,
    ]);
    for (const secret of ['TOKENSECRET', 'HEADERSECRET', 'URLSECRET']) {
      expect(text).not.toContain(secret);
    }
    expect(safe).not.toBe(original);
    expect(safe.code).toBe('ECONNRESET');
    expect(safe.data.nested[0]).toBe(1);
    expect(safe.cause.message).toContain('h.example');
    expect(original.message).toBe(before);
  });

  it('wraps non-Error values into an Error', () => {
    expect(sanitizeErrorForLogging('oops SECRET1234', ['SECRET1234']).message).toBe(
      `oops ${REDACTED}`,
    );
  });
});

describe('idempotence', () => {
  const texts = [
    'request to https://h.invalid/mcp?apikey=CANARY123 failed, reason: Client network socket disconnected',
    'GET https://a.example/p?k=SECRET1, then (http://u:SECRET2@b.example/).',
    'see [https://a.example/p?k=SECRET1] and https://[::1]:8080/x?y=2 and https://[::1]',
    'https://h.example/mcp/[REDACTED]/x?key=%5BREDACTED%5D&k=a+b&c%20d=1',
    'bad https://[bad-SECRET and ftp://u:p@h.example/f.txt?x=1#frag',
    'plain text without urls [REDACTED] [REDACTED]]',
  ];

  it.each(texts)('redactUrlsInText(redactUrlsInText(x)) === redactUrlsInText(x): %s', (text) => {
    const once = redactUrlsInText(text);

    expect(redactUrlsInText(once)).toBe(once);
    expect(redactUrlsInText(redactUrlsInText(once))).toBe(once);
  });

  it('sanitizeUrlForLogging is a fixed point on its own output', () => {
    for (const url of ['https://u:p@h.example:8443/a?x=1&y=2#f', 'not a url', 'https://[bad']) {
      const once = sanitizeUrlForLogging(url);
      expect(sanitizeUrlForLogging(once)).toBe(once);
    }
  });

  it('keeps the exact observed message shape stable: one marker, no trailing brackets', () => {
    const message =
      'request to https://h.invalid/mcp?apikey=CANARY123 failed, reason: Client network socket disconnected before secure TLS connection was established';

    const once = redactUrlsInText(message);

    expect(once).toBe(
      `request to https://h.invalid/mcp?apikey=${REDACTED} failed, reason: Client network socket disconnected before secure TLS connection was established`,
    );
    expect(redactUrlsInText(redactUrlsInText(redactUrlsInText(once)))).toBe(once);
  });

  it('does not accumulate brackets when an error is re-sanitized through four wrapping layers', () => {
    const base = 'request to https://h.invalid/mcp?apikey=CANARY123 failed, reason: socket hang up';
    const secrets = ['CANARY123'];

    let error: Error = new Error(`Fetch failed: ${base}`, { cause: new Error(base) });
    const onceMessage = sanitizeErrorForLogging(error, secrets).message;
    for (const layer of ['MCPClient', 'MCPService', 'tRPC', 'handler']) {
      error = sanitizeErrorForLogging(
        new Error(`${layer}: ${error.message}`, { cause: error }),
        secrets,
      );
    }

    const chainText: string[] = [];
    for (let current: any = error; current; current = current.cause) {
      chainText.push(current.message, current.stack);
    }
    const all = chainText.join('\n');

    expect(error.message).toBe(`handler: tRPC: MCPService: MCPClient: ${onceMessage}`);
    expect(all).not.toContain('CANARY123');
    expect(all).not.toMatch(/\[REDACTED\]\]/);
    expect(all).not.toMatch(/\[REDACTED\]\[/);
    expect(error.message.match(/apikey=\[REDACTED\]/g)).toHaveLength(1);
  });

  it('ignores secrets that are fragments of the marker itself', () => {
    expect(redactUrlsInText(sanitizeErrorForLogging(`x ${REDACTED}`, ['REDACTED']).message)).toBe(
      `x ${REDACTED}`,
    );
  });
});
