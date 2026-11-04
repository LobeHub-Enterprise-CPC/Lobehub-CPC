import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Shared secret our deliveries are signed with and our receivers verify against. */
export const getDeliverySigningKey = (): string | undefined =>
  process.env.DELIVERY_SIGNING_KEY || undefined;

interface SigningInput {
  body: string;
  messageId: string;
  now?: number;
  signingKey: string;
  url: string;
}

export const signUpstashRequest = ({
  body,
  url,
  messageId,
  signingKey,
  now = Date.now(),
}: SigningInput): string => {
  const iat = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'Upstash',
      sub: url,
      iat,
      nbf: iat,
      exp: iat + 300,
      jti: messageId,
      body: createHash('sha256').update(body).digest('base64url'),
    }),
  ).toString('base64url');
  const data = header + '.' + payload;
  return data + '.' + createHmac('sha256', signingKey).update(data).digest('base64url');
};

interface VerificationInput {
  body: string;
  now?: number;
  signature: string;
  signingKey: string;
  /** Checked only when given: our own routes accept a token without binding it to a URL. */
  url?: string;
}

const CLOCK_TOLERANCE_SECONDS = 1;

/** Verifies a signature made by {@link signUpstashRequest}: key, body bytes, lifetime, and optionally the URL. */
export const verifyDeliverySignature = ({
  body,
  now = Date.now(),
  signature,
  signingKey,
  url,
}: VerificationInput): boolean => {
  const parts = signature.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, mac] = parts;
  const expected = createHmac('sha256', signingKey)
    .update(header + '.' + payload)
    .digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;

  let claims: Record<string, unknown>;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (decoded?.alg !== 'HS256') return false;
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return false;
  }
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== 'Upstash') return false;
  if (typeof claims.exp !== 'number' || seconds > claims.exp + CLOCK_TOLERANCE_SECONDS)
    return false;
  if (typeof claims.nbf === 'number' && seconds < claims.nbf - CLOCK_TOLERANCE_SECONDS)
    return false;
  if (url !== undefined && claims.sub !== url) return false;
  return claims.body === createHash('sha256').update(body).digest('base64url');
};

/**
 * Whether `request` carries a valid delivery signature over `rawBody`. False when no
 * signing key is configured: callers that tolerate unsigned requests check that first.
 */
export const verifyDeliveryRequest = (request: Request, rawBody: string): boolean => {
  const signingKey = getDeliverySigningKey();
  const signature = request.headers.get('Upstash-Signature');
  if (!signingKey || !signature) return false;
  return verifyDeliverySignature({ body: rawBody, signature, signingKey });
};
