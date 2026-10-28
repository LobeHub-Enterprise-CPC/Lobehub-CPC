import { describe, expect, it } from 'vitest';

import {
  collectMcpSecrets,
  REDACTED,
  sanitizeErrorForMcp,
  sanitizeMcpParamsForLogging,
  sanitizeUrlForLogging,
} from '../sanitize';

describe('sanitizeMcpParamsForLogging', () => {
  it('masks oauth2 auth secrets but keeps non-secret shape, without mutating input', () => {
    const params = {
      auth: {
        accessToken: 'at',
        clientId: undefined,
        clientSecret: 'cs',
        refreshToken: 'rt',
        tokenExpiresAt: 123,
        type: 'oauth2',
      },
      name: 'srv',
      type: 'http',
    };
    const snapshot = structuredClone(params);

    expect(sanitizeMcpParamsForLogging(params)).toEqual({
      auth: {
        accessToken: REDACTED,
        clientId: undefined,
        clientSecret: REDACTED,
        refreshToken: REDACTED,
        tokenExpiresAt: 123,
        type: 'oauth2',
      },
      name: 'srv',
      type: 'http',
    });
    expect(params).toEqual(snapshot);
  });

  it('keeps header and env names, masks values', () => {
    expect(
      sanitizeMcpParamsForLogging({
        env: { API_KEY: 'x' },
        headers: { Authorization: 'Bearer y' },
      }),
    ).toEqual({ env: { API_KEY: REDACTED }, headers: { Authorization: REDACTED } });
  });

  it('masks credential-looking keys at any depth, including whole objects', () => {
    expect(
      sanitizeMcpParamsForLogging({
        deploymentOptions: [{ connection: { apiKey: 'k', credentials: { a: 1 }, ok: 'v' } }],
      }),
    ).toEqual({
      deploymentOptions: [{ connection: { apiKey: REDACTED, credentials: REDACTED, ok: 'v' } }],
    });
  });

  it('masks values of secret-looking stdio flags in both forms and URL args', () => {
    expect(
      sanitizeMcpParamsForLogging({
        args: ['-y', 'srv', '--api-key', 'a', '--token=b', '--port', '80', 'https://u:p@h/x?k=v'],
      }),
    ).toEqual({
      args: [
        '-y',
        'srv',
        '--api-key',
        REDACTED,
        `--token=${REDACTED}`,
        '--port',
        '80',
        `https://h/x?k=${REDACTED}`,
      ],
    });
  });

  it('passes through null/undefined and primitives', () => {
    expect(sanitizeMcpParamsForLogging(undefined)).toBeUndefined();
    expect(sanitizeMcpParamsForLogging(null)).toBeNull();
  });
});

describe('sanitizeUrlForLogging', () => {
  it('drops userinfo and fragment, masks query values, keeps host/path/query names', () => {
    expect(sanitizeUrlForLogging('https://u:p@h.example:8443/a/b?x=1&y=2#frag')).toBe(
      `https://h.example:8443/a/b?x=${REDACTED}&y=${REDACTED}`,
    );
  });

  it('does not echo unparseable input', () => {
    expect(sanitizeUrlForLogging('sk-secret-not-a-url')).not.toContain('sk-secret');
  });
});

describe('collectMcpSecrets / sanitizeErrorForMcp', () => {
  const params = {
    args: ['--api-key', 'ARGSECRET1', '--token=EQSECRET1'],
    auth: {
      accessToken: 'ACCESS123',
      clientSecret: 'CLIENT123',
      scope: 'public-scope',
      type: 'oauth2',
    },
    env: { API_KEY: 'ENVSECRET1' },
    headers: { Authorization: 'Bearer HEADER123' },
    url: 'https://usr:PASS1234@h.example/mcp?apikey=QUERY123',
  };

  it('collects every credential-bearing value but not public auth metadata', () => {
    const secrets = collectMcpSecrets(params);

    for (const secret of [
      'ARGSECRET1',
      'EQSECRET1',
      'ACCESS123',
      'CLIENT123',
      'ENVSECRET1',
      'Bearer HEADER123',
      'PASS1234',
      'QUERY123',
    ]) {
      expect(secrets).toContain(secret);
    }
    expect(secrets).not.toContain('public-scope');
    expect(secrets).not.toContain('oauth2');
  });

  it('removes them from an error, including the bare bearer token', () => {
    const safe = sanitizeErrorForMcp(
      new Error('boom HEADER123 ACCESS123 ENVSECRET1 https://h.example/mcp?apikey=QUERY123'),
      params,
    );

    for (const secret of ['HEADER123', 'ACCESS123', 'ENVSECRET1', 'QUERY123']) {
      expect(safe.message).not.toContain(secret);
    }
    expect(safe.message).toContain('h.example/mcp');
  });

  it('is idempotent: re-sanitizing at every layer does not accumulate brackets', () => {
    const message = `Fetch failed: request to https://h.invalid/mcp?apikey=QUERY123 failed, reason: ${params.headers.Authorization}`;
    let error: Error = new Error(message);
    const once = sanitizeErrorForMcp(error, {
      ...params,
      url: 'https://h.invalid/mcp?apikey=QUERY123',
    });

    for (let i = 0; i < 4; i++) {
      error = sanitizeErrorForMcp(error, {
        ...params,
        url: 'https://h.invalid/mcp?apikey=QUERY123',
      });
    }

    expect(error.message).toBe(once.message);
    expect(error.message.match(/apikey=\[REDACTED\]/g)).toHaveLength(1);
    expect(error.message).not.toContain(']]');
  });
});
