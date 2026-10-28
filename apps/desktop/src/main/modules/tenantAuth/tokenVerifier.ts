import crypto from 'node:crypto';

import { isSecureOrLoopbackUrl } from './entry';
import { fetchNoRedirect, readJsonLimited } from './safeFetch';

/** Same claim the server signs into every tenant access token (`TENANT_ID_CLAIM`). */
export const TENANT_ID_CLAIM = 'tid';

export const DESKTOP_CLIENT_ID = 'tituwork-desktop';
export const ACCESS_TOKEN_AUDIENCE = 'urn:lobehub:chat';

/** Clock skew tolerated on `iat`. */
export const CLOCK_SKEW_SECONDS = 120;

const MAX_TOKEN_CHARS = 24 * 1024;
const MAX_HEADER_CHARS = 2 * 1024;
const MAX_PAYLOAD_CHARS = 16 * 1024;
const MAX_SIGNATURE_CHARS = 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 32;
const MIN_RSA_MODULUS_BITS = 2048;
const JWKS_TTL_MS = 10 * 60 * 1000;

const BASE64URL = /^[\w-]+$/;

export class TokenVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

const fail = (message: string): never => {
  throw new TokenVerificationError(message);
};

type JsonObject = Record<string, unknown>;

interface RsaJwk extends JsonObject {
  e: string;
  kid?: string;
  kty: 'RSA';
  n: string;
}

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const decodeSegment = (segment: string, maxChars: number, name: string): JsonObject => {
  if (!segment || segment.length > maxChars || !BASE64URL.test(segment)) {
    return fail(`Malformed JWT ${name}`);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!isPlainObject(parsed)) return fail(`Malformed JWT ${name}`);
    return parsed;
  } catch (error) {
    if (error instanceof TokenVerificationError) throw error;
    return fail(`Malformed JWT ${name}`);
  }
};

export interface JwksResolver {
  /**
   * The single RSA signature key with this `kid` from the issuer's own JWKS. An unknown
   * `kid` refreshes the issuer's JWKS at most once; still unknown (or ambiguous) rejects.
   */
  resolveKey: (issuer: string, kid: string) => Promise<crypto.KeyObject>;
}

interface JwksCacheEntry {
  fetchedAt: number;
  keys: RsaJwk[];
}

const isRsaSigningJwk = (key: unknown): key is RsaJwk =>
  isPlainObject(key) &&
  key.kty === 'RSA' &&
  typeof key.n === 'string' &&
  typeof key.e === 'string' &&
  (key.use === undefined || key.use === 'sig') &&
  (key.alg === undefined || key.alg === 'RS256');

/**
 * JWKS access bound to a single issuer: keys come only from `<issuer>/jwks` (the bound
 * entry's own endpoint), never from a `jku`/`x5u`/`jwk` the token points at. Caches are
 * per issuer so one organization's keys can never validate another's tokens.
 */
export const createJwksResolver = (
  options: { allowLoopbackHttp?: boolean; now?: () => number } = {},
): JwksResolver => {
  const now = options.now ?? Date.now;
  const cache = new Map<string, JwksCacheEntry>();
  const inflight = new Map<string, Promise<JwksCacheEntry>>();

  const fetchJwks = async (issuer: string): Promise<JwksCacheEntry> => {
    const url = new URL(`${issuer}/jwks`);
    if (!isSecureOrLoopbackUrl(url, options.allowLoopbackHttp === true)) {
      return fail('JWKS endpoint must use https');
    }

    const response = await fetchNoRedirect(url.toString(), {
      headers: { Accept: 'application/json' },
      method: 'GET',
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return fail(`JWKS request failed with status ${response.status}`);
    }

    const body = await readJsonLimited<unknown>(response, MAX_JWKS_BYTES);
    if (!isPlainObject(body) || !Array.isArray(body.keys) || body.keys.length > MAX_JWKS_KEYS) {
      return fail('Malformed JWKS');
    }

    return { fetchedAt: now(), keys: body.keys.filter((key) => isRsaSigningJwk(key)) };
  };

  const refresh = (issuer: string): Promise<JwksCacheEntry> => {
    const existing = inflight.get(issuer);
    if (existing) return existing;

    const pending = fetchJwks(issuer)
      .then((entry) => {
        cache.set(issuer, entry);
        return entry;
      })
      .finally(() => inflight.delete(issuer));
    inflight.set(issuer, pending);
    return pending;
  };

  const matches = (entry: JwksCacheEntry, kid: string) =>
    entry.keys.filter((key) => key.kid === kid);

  return {
    resolveKey: async (issuer, kid) => {
      let entry = cache.get(issuer);
      let refreshed = false;
      if (!entry || now() - entry.fetchedAt > JWKS_TTL_MS) {
        entry = await refresh(issuer);
        refreshed = true;
      }

      let candidates = matches(entry, kid);
      if (candidates.length === 0 && !refreshed) {
        candidates = matches(await refresh(issuer), kid);
      }

      if (candidates.length !== 1) {
        return fail(candidates.length === 0 ? 'Unknown signing key' : 'Ambiguous signing key');
      }

      try {
        // Only the public RSA members are handed to crypto.
        const key = crypto.createPublicKey({
          format: 'jwk',
          key: { e: candidates[0].e, kty: 'RSA', n: candidates[0].n },
        });
        if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS) {
          return fail('Signing key is too weak');
        }
        return key;
      } catch (error) {
        if (error instanceof TokenVerificationError) throw error;
        return fail('Invalid signing key');
      }
    },
  };
};

export interface VerifyTokenOptions {
  /** Exactly this audience, as a string or a single-element array. */
  audience: string;
  /** When present in the token, `azp` must be this value. */
  authorizedParty?: string;
  expectedIssuer: string;
  jwks: JwksResolver;
  /** Authorization start (ms): `iat` may not be older than this minus the clock skew. */
  notBefore: number;
  /** Time source in ms; injectable for tests. */
  now?: number;
  token: string;
}

export interface VerifiedToken {
  claims: JsonObject;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const audienceMatches = (aud: unknown, expected: string) =>
  aud === expected || (Array.isArray(aud) && aud.length === 1 && aud[0] === expected);

/**
 * Verify a compact RS256 JWT issued by one pre-selected issuer. Fails closed: any problem
 * throws `TokenVerificationError`; the token is never usable (or displayable) otherwise.
 */
export const verifyRs256Jwt = async (options: VerifyTokenOptions): Promise<VerifiedToken> => {
  const { token } = options;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    return fail('Malformed JWT');
  }

  const parts = token.split('.');
  if (parts.length !== 3) return fail('Malformed JWT');
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeSegment(headerPart, MAX_HEADER_CHARS, 'header');
  const claims = decodeSegment(payloadPart, MAX_PAYLOAD_CHARS, 'payload');
  if (
    !signaturePart ||
    signaturePart.length > MAX_SIGNATURE_CHARS ||
    !BASE64URL.test(signaturePart)
  ) {
    return fail('Malformed JWT signature');
  }

  // `crit` names extensions this client does not implement; `jku`/`x5u`/`jwk`/`x5c`
  // are ignored on purpose (keys only come from the bound issuer's JWKS).
  if ('crit' in header) return fail('Unsupported JWT extension');
  if (header.alg !== 'RS256') return fail('Unsupported JWT algorithm');
  if (typeof header.kid !== 'string' || header.kid.length === 0) return fail('Missing key id');

  const key = await options.jwks.resolveKey(options.expectedIssuer, header.kid);
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart, 'base64url'),
  );
  if (!valid) return fail('Invalid signature');

  if (claims.iss !== options.expectedIssuer) return fail('Unexpected issuer');
  if (!audienceMatches(claims.aud, options.audience)) return fail('Unexpected audience');
  if (
    options.authorizedParty !== undefined &&
    claims.azp !== undefined &&
    claims.azp !== options.authorizedParty
  ) {
    return fail('Unexpected authorized party');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return fail('Missing subject');

  const { exp, iat } = claims;
  if (!isFiniteNumber(iat) || !isFiniteNumber(exp)) return fail('Missing token times');

  const nowSeconds = (options.now ?? Date.now()) / 1000;
  const notBeforeSeconds = options.notBefore / 1000;
  if (iat < notBeforeSeconds - CLOCK_SKEW_SECONDS) return fail('Token predates the authorization');
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return fail('Token issued in the future');
  if (!(exp > nowSeconds) || !(exp > iat)) return fail('Token expired');

  return { claims };
};

/** Display account: `email`, then `preferred_username`, then `sub`. */
export const pickAccountDisplay = (claims: JsonObject): string => {
  for (const name of ['email', 'preferred_username'] as const) {
    const value = claims[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return String(claims.sub);
};

/** Tenant id of a verified access token, from the server's tenant claim. */
export const readTenantId = (claims: JsonObject): string | null => {
  const value = claims[TENANT_ID_CLAIM];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const MAX_TENANT_NAME_CHARS = 4096;
const MAX_TENANT_SLUG_CHARS = 128;
const TENANT_SLUG = /^[a-z][\da-z]*(?:-[\da-z]+)*$/;

export interface TenantDisplayClaims {
  /** `has_other_organizations`: whether the account belongs to other organizations too. */
  hasOtherOrganizations?: boolean;
  /** `tenant_name` */
  name?: string;
  /** `tenant_slug` */
  slug?: string;
}

/**
 * Display-only organization claims of a verified id_token. Each claim is optional and
 * checked on its own; an invalid one counts as absent (never an error) and none of them
 * takes part in any trust decision.
 */
export const readTenantDisplayClaims = (claims: JsonObject): TenantDisplayClaims => {
  const { has_other_organizations: other, tenant_name: name, tenant_slug: slug } = claims;

  return {
    ...(typeof name === 'string' && name.length > 0 && name.length <= MAX_TENANT_NAME_CHARS
      ? { name }
      : {}),
    ...(typeof slug === 'string' && slug.length <= MAX_TENANT_SLUG_CHARS && TENANT_SLUG.test(slug)
      ? { slug }
      : {}),
    ...(typeof other === 'boolean' ? { hasOtherOrganizations: other } : {}),
  };
};

export const verifyIdToken = (
  options: Omit<VerifyTokenOptions, 'audience' | 'authorizedParty'>,
): Promise<VerifiedToken> =>
  verifyRs256Jwt({ ...options, audience: DESKTOP_CLIENT_ID, authorizedParty: DESKTOP_CLIENT_ID });

export const verifyAccessToken = (
  options: Omit<VerifyTokenOptions, 'audience' | 'authorizedParty'>,
): Promise<VerifiedToken> => verifyRs256Jwt({ ...options, audience: ACCESS_TOKEN_AUDIENCE });
