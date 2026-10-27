import { oidcClients } from '@lobechat/database/schemas';
import { requireTenantScope } from '@lobechat/database/tenant';
import { eq } from 'drizzle-orm';
import type {
  AccessToken,
  ClientCredentials,
  JWTStructured,
  KoaContextWithOIDC,
} from 'oidc-provider';

import { getServerDB } from '@/database/core/db-adaptor';
import { getRedisConfig } from '@/envs/redis';
import { redisService } from '@/server/services/redis';

import { GatewayAuthorizationError } from './wire';

export const gatewayOIDCClients = new Set(['tituwork-desktop', 'lobehub-cli']);

/** Runs before signing JWT-format access tokens, which do not have adapter AccessToken rows. */
export const projectGatewayOIDCAccess = async (
  _ctx: KoaContextWithOIDC,
  token: AccessToken | ClientCredentials,
  parts: JWTStructured,
) => {
  const payload = parts.payload;
  const clientId = token.clientId;
  if (!clientId || !gatewayOIDCClients.has(clientId)) return;
  // A deployment without Redis keeps issuing OIDC tokens: the gateway rejects
  // these tokens at use because it cannot read the projection, but devices that
  // only call the regular API still need a completed device flow. A configured
  // Redis that fails to write still fails closed below.
  if (!getRedisConfig().enabled) {
    console.warn('[OIDC] Gateway projection skipped: Redis is not configured');
    return;
  }
  if (
    !('grantId' in token) ||
    !token.grantId ||
    typeof payload.jti !== 'string' ||
    typeof payload.sub !== 'string' ||
    typeof payload.exp !== 'number' ||
    typeof payload.iss !== 'string'
  )
    throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
  const [client] = await (
    await getServerDB()
  )
    .select({ enabled: oidcClients.enabled })
    .from(oidcClients)
    .where(eq(oidcClients.id, clientId))
    .limit(1);
  if (client && !client.enabled) throw new GatewayAuthorizationError('UNAUTHORIZED');
  const boundSessionUid =
    'sessionUid' in token && typeof token.sessionUid === 'string' ? token.sessionUid : undefined;
  await redisService.gatewayAuthorization.putOIDCProjection(payload.jti, {
    tenantId: requireTenantScope().tenantId,
    issuer: payload.iss,
    clientId,
    clientAuthority: client ? 'database' : 'static',
    subject: payload.sub,
    grantId: token.grantId,
    accessTokenExpiresAt: payload.exp * 1000,
    ...(boundSessionUid ? { boundSessionUid } : {}),
  });
};
