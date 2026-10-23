import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_COOKIE_INFO,
  ACCOUNT_COOKIE_MAX_AGE,
  accountCookieAvailable,
  accountCookieName,
  accountCookieValue,
  clearAccountCookie,
  readAccountMemory,
  sealAccountMemory,
  serializeAccountCookie,
} from './accountCookie';

const SECRET = 'test-account-cookie-secret';
const HTTPS = 'https://app.example.com';
const HTTP = 'http://localhost:3010';

const keyFor = (info = ACCOUNT_COOKIE_INFO) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(SECRET), Buffer.alloc(0), Buffer.from(info), 32));

const sealWith = (
  payload: Record<string, unknown>,
  { info = ACCOUNT_COOKIE_INFO, secret = SECRET } = {},
) => {
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from(info), 32),
  );
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
};

const valueOf = (setCookie: string) => setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0];
const now = () => Math.floor(Date.now() / 1000);
const memory = (overrides: Record<string, unknown> = {}) => ({
  email: 'user@example.com',
  iat: now(),
  tenantId: 'tenant-1',
  v: 1,
  ...overrides,
});

beforeEach(() => {
  vi.stubEnv('KEY_VAULTS_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('account memory value', () => {
  it('round-trips through the platform cookie and encrypts with the contract HKDF info', () => {
    const setCookie = serializeAccountCookie('User@Example.com ', 'tenant-1', HTTPS);
    expect(setCookie).not.toBeNull();
    const value = valueOf(setCookie!);
    expect(readAccountMemory(value)).toEqual({
      email: 'user@example.com',
      iat: expect.any(Number),
      tenantId: 'tenant-1',
    });

    // An independent decryption with the documented info proves the derivation, not just
    // the round trip.
    const raw = Buffer.from(value, 'base64url');
    const reader = createDecipheriv('aes-256-gcm', keyFor(), raw.subarray(0, 12));
    reader.setAuthTag(raw.subarray(raw.length - 16));
    const plaintext = Buffer.concat([
      reader.update(raw.subarray(12, raw.length - 16)),
      reader.final(),
    ]).toString('utf8');
    expect(JSON.parse(plaintext)).toMatchObject({
      email: 'user@example.com',
      tenantId: 'tenant-1',
      v: 1,
    });
  });

  it.each([
    ['the IV', 0],
    ['the ciphertext', 13],
    ['the tag', 20],
  ])('rejects a flipped byte in %s', (_part, index) => {
    const value = sealWith(memory());
    const raw = Buffer.from(value, 'base64url');
    raw[index] ^= 0xff;
    expect(readAccountMemory(raw.toString('base64url'))).toBeNull();
  });

  it.each([
    ['a wrong-format value', 'not base64url!'],
    ['a too-short value', 'AAAA'],
    ['a value encrypted under another info', sealWith(memory(), { info: 'lobe:other:v1' })],
    ['a value encrypted under another secret', sealWith(memory(), { secret: 'other-secret' })],
  ])('treats %s as absent', (_name, value) => {
    expect(readAccountMemory(value)).toBeNull();
  });

  it.each([
    ['v is not 1', memory({ v: 2 })],
    ['the email is invalid', memory({ email: 'not-an-email' })],
    ['the tenant id is invalid', memory({ tenantId: 'bad/value' })],
    ['iat is missing', memory({ iat: undefined })],
  ])('rejects a payload whose %s', (_name, payload) => {
    expect(readAccountMemory(sealWith(payload))).toBeNull();
  });

  it('rejects a value older than 180 days and one more than 300 seconds in the future', () => {
    expect(
      readAccountMemory(sealWith(memory({ iat: now() - ACCOUNT_COOKIE_MAX_AGE - 1 }))),
    ).toBeNull();
    expect(readAccountMemory(sealWith(memory({ iat: now() + 301 })))).toBeNull();
    expect(
      readAccountMemory(sealWith(memory({ iat: now() - ACCOUNT_COOKIE_MAX_AGE + 5 }))),
    ).not.toBeNull();
    expect(readAccountMemory(sealWith(memory({ iat: now() + 295 })))).not.toBeNull();
  });

  it('is off entirely without a secret: no sealing, no reading, no availability', () => {
    const value = valueOf(serializeAccountCookie('user@example.com', 'tenant-1', HTTPS)!);
    vi.stubEnv('KEY_VAULTS_SECRET', undefined);
    expect(accountCookieAvailable()).toBe(false);
    expect(sealAccountMemory('user@example.com', 'tenant-1')).toBeNull();
    expect(serializeAccountCookie('user@example.com', 'tenant-1', HTTPS)).toBeNull();
    expect(readAccountMemory(value)).toBeNull();
  });
});

describe('account cookie attributes', () => {
  it('is host-only, root-scoped and secure only on https', () => {
    const secure = serializeAccountCookie('user@example.com', 'tenant-1', HTTPS)!;
    expect(secure).toMatch(
      /^__Host-lobe-last-account=[\w-]+; Path=\/; Max-Age=15552000; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(secure).not.toContain('Domain=');

    const insecure = serializeAccountCookie('user@example.com', 'tenant-1', HTTP)!;
    expect(insecure).toMatch(
      /^lobe-last-account=[\w-]+; Path=\/; Max-Age=15552000; HttpOnly; SameSite=Lax$/,
    );
    expect(insecure).not.toContain('Secure');
    expect(insecure).not.toContain('Domain=');
  });

  it('clears with the same name and path', () => {
    expect(clearAccountCookie(HTTPS)).toBe(
      '__Host-lobe-last-account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
    expect(clearAccountCookie(HTTP)).toBe(
      'lobe-last-account=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    );
  });

  it('uses the platform cookie name and reads only that exact name', () => {
    expect(accountCookieName(HTTPS)).toBe('__Host-lobe-last-account');
    expect(accountCookieName(HTTP)).toBe('lobe-last-account');
    const headers = new Headers({
      cookie: 'lobe-last-account-other=nope; lobe-last-account=yes; lobe-last-account.1=no',
    });
    expect(accountCookieValue(headers, HTTP)).toBe('yes');
    expect(accountCookieValue(new Headers(), HTTP)).toBeUndefined();
  });
});
