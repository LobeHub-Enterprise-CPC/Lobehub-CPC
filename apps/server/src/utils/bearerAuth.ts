import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Compare two secrets without leaking where they differ (or how long the
 * expected one is) through comparison timing: both sides are hashed to a fixed
 * length first, as `tenantControlPlane/auth.ts` does.
 */
export const secretsEqual = (given: string, expected: string): boolean =>
  timingSafeEqual(digest(given), digest(expected));

/** Whether an `Authorization` header value is exactly `Bearer <secret>`. */
export const isBearerSecret = (authorization: string | null | undefined, secret: string): boolean =>
  secretsEqual(authorization ?? '', `Bearer ${secret}`);
