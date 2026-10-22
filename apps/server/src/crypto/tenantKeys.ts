import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Keys derived from the master secret (spec A18, A20). Nothing derived here is
 * stored or sent: LobeHub and Admin configure the same `KEY_VAULTS_SECRET` and
 * compute the same tenant key independently, so these parameters must stay
 * byte-for-byte identical to Admin's `src/server/crypto/tenantKeys.ts`.
 *
 * - IKM: UTF-8 bytes of `KEY_VAULTS_SECRET` (the only key setting).
 * - Tenant data key: HKDF-SHA256(ikm, salt = empty, info = "lobehub:tenant-data:" + tenantId, 32)
 * - Directory key:   HKDF-SHA256(ikm, salt = empty, info = "lobehub:tenant-directory", 32)
 *
 * Every secret stored inside a tenant schema (key vaults, provider keys, SSO
 * secrets, …) is sealed with that tenant's data key. Credential bundles in the
 * platform `tenant_directory` are sealed with the directory key. Process-level
 * uses (OIDC cookie signing, API key hashing) keep using the master secret
 * directly.
 *
 * Ciphertexts carry no key id or version. There is no rotation in code:
 * changing the master secret is an offline re-encryption.
 */
export const TENANT_DATA_KEY_INFO_PREFIX = 'lobehub:tenant-data:';
export const DIRECTORY_KEY_INFO = 'lobehub:tenant-directory';

export type MasterKeyErrorCode = 'ENCRYPTED_PAYLOAD_INVALID' | 'MASTER_KEY_UNAVAILABLE';

export class MasterKeyError extends Error {
  constructor(readonly code: MasterKeyErrorCode) {
    super(code);
    this.name = 'MasterKeyError';
  }
}

type Env = Record<string, string | undefined>;

const masterIkm = (env: Env) => {
  const secret = env.KEY_VAULTS_SECRET;
  if (!secret) throw new MasterKeyError('MASTER_KEY_UNAVAILABLE');
  return Buffer.from(secret, 'utf8');
};

const hkdf = (ikm: Buffer, info: string) =>
  Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));

export const deriveTenantDataKey = (tenantId: string, env: Env = process.env): Buffer => {
  if (!tenantId) throw new MasterKeyError('MASTER_KEY_UNAVAILABLE');
  return hkdf(masterIkm(env), `${TENANT_DATA_KEY_INFO_PREFIX}${tenantId}`);
};

export const deriveDirectoryKey = (env: Env = process.env): Buffer =>
  hkdf(masterIkm(env), DIRECTORY_KEY_INFO);

const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM envelope `v1.<iv>.<ciphertext>.<tag>` (base64url parts, 12-byte
 * IV, 16-byte tag). `aad` binds the ciphertext to its context so it cannot be
 * replayed onto another row, tenant or provider.
 */
export const sealWithKey = (key: Buffer, plaintext: string, aad = ''): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    body.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
};

export const openWithKey = (key: Buffer, envelope: string, aad = ''): string => {
  const [format, iv, body, tag, ...rest] = envelope.split('.');
  if (format !== ENVELOPE_VERSION || !iv || body === undefined || !tag || rest.length > 0)
    throw new MasterKeyError('ENCRYPTED_PAYLOAD_INVALID');
  try {
    const ivBytes = Buffer.from(iv, 'base64url');
    const tagBytes = Buffer.from(tag, 'base64url');
    if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES)
      throw new MasterKeyError('ENCRYPTED_PAYLOAD_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', key, ivBytes);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new MasterKeyError('ENCRYPTED_PAYLOAD_INVALID');
  }
};

/** Data stored inside a tenant schema. */
export const sealTenantData = (tenantId: string, plaintext: string, aad = '') =>
  sealWithKey(deriveTenantDataKey(tenantId), plaintext, aad);

export const openTenantData = (tenantId: string, envelope: string, aad = '') =>
  openWithKey(deriveTenantDataKey(tenantId), envelope, aad);

/** Credential bundles in the platform tenant directory. */
export const sealDirectoryData = (plaintext: string, aad: string) =>
  sealWithKey(deriveDirectoryKey(), plaintext, aad);

export const openDirectoryData = (envelope: string, aad: string) =>
  openWithKey(deriveDirectoryKey(), envelope, aad);
