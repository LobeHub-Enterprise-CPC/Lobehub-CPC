import { createHash, timingSafeEqual } from 'node:crypto';

const MIN_TOKEN_LENGTH = 32;

const digest = (token: string) => createHash('sha256').update(token).digest();

/** Console's shared service token. Missing configuration disables the control plane. */
export const parseControlPlaneToken = (token?: string): Buffer | null => {
  if (!token) return null;
  if (token.length < MIN_TOKEN_LENGTH)
    throw new Error(`control-plane token must be at least ${MIN_TOKEN_LENGTH} characters`);
  return digest(token);
};

/** Compare fixed-length digests without exposing token matches through comparison timing. */
export const isAuthorized = (tokenDigest: Buffer, authorization: string | undefined): boolean => {
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  return !!match && timingSafeEqual(tokenDigest, digest(match[1]));
};
