import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { isValidTenantId } from './navigation';
import { discoveryEmailSchema } from './protection';

export const ACCOUNT_COOKIE_INFO = 'lobe:last-account:v1';
export const ACCOUNT_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;
export const ACCOUNT_COOKIE_NAME = '__Host-lobe-last-account';
export const ACCOUNT_COOKIE_INSECURE_NAME = 'lobe-last-account';

const MAX_FUTURE_SECONDS = 300;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[\w-]+$/;

export interface AccountMemory {
  email: string;
  iat: number;
  tenantId: string;
}

const accountPayloadSchema = z
  .object({
    email: discoveryEmailSchema,
    iat: z.number().int(),
    tenantId: z.string().refine(isValidTenantId),
    v: z.literal(1),
  })
  .strict();

export const accountCookieName = (appUrl: string): string =>
  new URL(appUrl).protocol === 'https:' ? ACCOUNT_COOKIE_NAME : ACCOUNT_COOKIE_INSECURE_NAME;

const accountKey = (): Buffer | null => {
  const secret = process.env.KEY_VAULTS_SECRET;
  if (!secret) return null;
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(ACCOUNT_COOKIE_INFO, 'utf8'),
      32,
    ),
  );
};

export const accountCookieAvailable = (): boolean => accountKey() !== null;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const seal = (payload: Record<string, unknown>, key: Buffer): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
};

export const sealAccountMemory = (
  email: string,
  tenantId: string,
  iat = nowSeconds(),
): string | null => {
  if (!isValidTenantId(tenantId)) return null;
  const parsed = discoveryEmailSchema.safeParse(email);
  if (!parsed.success) return null;
  const key = accountKey();
  if (!key) return null;
  try {
    return seal({ email: parsed.data, iat, tenantId, v: 1 }, key);
  } catch {
    return null;
  }
};

/** Treats every malformed, forged or stale value as absent; never throws. */
export const readAccountMemory = (value: string | undefined): AccountMemory | null => {
  if (!value || !BASE64URL.test(value)) return null;
  const key = accountKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    const parsed = accountPayloadSchema.safeParse(JSON.parse(plaintext));
    if (!parsed.success) return null;
    const now = nowSeconds();
    if (now - parsed.data.iat > ACCOUNT_COOKIE_MAX_AGE) return null;
    if (parsed.data.iat - now > MAX_FUTURE_SECONDS) return null;
    return {
      email: parsed.data.email,
      iat: parsed.data.iat,
      tenantId: parsed.data.tenantId,
    };
  } catch {
    return null;
  }
};

const cookie = (value: string, appUrl: string, maxAge: number) =>
  `${accountCookieName(appUrl)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(appUrl).protocol === 'https:' ? '; Secure' : ''}`;

/** `null` when there is no signing secret: the feature is off and nothing may be written. */
export const serializeAccountCookie = (
  email: string,
  tenantId: string,
  appUrl: string,
  iat?: number,
): string | null => {
  const value = sealAccountMemory(email, tenantId, iat);
  return value ? cookie(value, appUrl, ACCOUNT_COOKIE_MAX_AGE) : null;
};

export const clearAccountCookie = (appUrl: string): string => cookie('', appUrl, 0);

/** The account cookie's raw value from a request, matched by its exact name. */
export const accountCookieValue = (headers: Headers, appUrl: string): string | undefined => {
  const name = accountCookieName(appUrl);
  for (const pair of (headers.get('cookie') ?? '').split(';')) {
    const trimmed = pair.trim();
    const equals = trimmed.indexOf('=');
    if (equals > 0 && trimmed.slice(0, equals) === name) return trimmed.slice(equals + 1);
  }
};
