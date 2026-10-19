import { importJWK, type JWK, jwtVerify, SignJWT } from 'jose';

import { authEnv } from '@/envs/auth';
import type { GatewayAudience } from '@/server/services/gatewayAuthorization/types';
import {
  GatewayAuthorizationError,
  parseGatewayWire,
} from '@/server/services/gatewayAuthorization/wire';

const keys = () => {
  const jwks = JSON.parse(authEnv.JWKS_KEY || '{}') as { keys?: JWK[] };
  const available = jwks.keys?.filter((key) => key.alg === 'RS256' && key.kty === 'RSA' && key.kid);
  if (!available?.length) throw new GatewayAuthorizationError('GATEWAY_AUTHORITY_UNAVAILABLE', 503);
  return available;
};
const sign = async (claims: Record<string, unknown>) => {
  const jwk = keys().find((key) => key.d);
  if (!jwk) throw new GatewayAuthorizationError('GATEWAY_AUTHORITY_UNAVAILABLE', 503);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .sign(await importJWK(jwk, 'RS256'));
};
export const signGatewayJWT = async (claims: Record<string, unknown>) => {
  parseGatewayWire('tokenClaims', claims);
  return sign(claims);
};
/**
 * A workspace-enrollment attestation is signed with the gateway key but is not a
 * ticket: its purpose is `gateway-enrollment`, so the gateway refuses it. Clients
 * read it only to pin the tenant and workspace a later identity exchange must match.
 */
export const signGatewayEnrollmentJWT = async (claims: Record<string, unknown>) => {
  if (claims.purpose !== 'gateway-enrollment' || 'device_id' in claims)
    throw new GatewayAuthorizationError('INVALID_GATEWAY_MESSAGE', 400);
  return sign(claims);
};
export const verifyGatewayJWT = async (
  token: string,
  audience: GatewayAudience,
  tenantId: string,
) => {
  const { payload } = await jwtVerify(
    token,
    async (header) => {
      parseGatewayWire('jwtHeader', header);
      const jwk = keys().find((key) => key.kid === header.kid);
      if (!jwk) throw new GatewayAuthorizationError('UNAUTHORIZED');
      return importJWK({ kty: 'RSA', n: jwk.n, e: jwk.e }, 'RS256');
    },
    {
      algorithms: ['RS256'],
      audience,
      issuer: 'urn:lobehub:gateway-session',
      clockTolerance: 2,
      requiredClaims: ['iat', 'exp', 'jti', 'sub'],
    },
  );
  parseGatewayWire('tokenClaims', payload);
  const now = Date.now() / 1000;
  if (
    payload.tid !== tenantId ||
    payload.purpose !== 'gateway-connect' ||
    payload.iat! > now + 2 ||
    payload.exp! - payload.iat! > 300 ||
    payload.exp! <= payload.iat!
  )
    throw new GatewayAuthorizationError('UNAUTHORIZED');
  return payload;
};
