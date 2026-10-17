import { describe, expect, it } from 'vitest';

import { isAuthorized, parseControlPlaneToken } from '../auth';

const TOKEN = 't'.repeat(32);

describe('parseControlPlaneToken', () => {
  it('returns null when no token is configured', () => {
    expect(parseControlPlaneToken()).toBeNull();
    expect(parseControlPlaneToken('')).toBeNull();
  });

  it('rejects a token shorter than 32 characters', () => {
    expect(() => parseControlPlaneToken('short')).toThrow();
  });
});

describe('isAuthorized', () => {
  const tokenDigest = parseControlPlaneToken(TOKEN)!;

  it('accepts the configured Console token', () => {
    expect(isAuthorized(tokenDigest, `Bearer ${TOKEN}`)).toBe(true);
  });

  it.each([
    undefined,
    TOKEN,
    'Bearer ',
    `Basic ${TOKEN}`,
    `Bearer ${TOKEN}x`,
    `Bearer ${'x'.repeat(32)}`,
  ])('refuses a missing, malformed or wrong token: %s', (authorization) => {
    expect(isAuthorized(tokenDigest, authorization)).toBe(false);
  });
});
