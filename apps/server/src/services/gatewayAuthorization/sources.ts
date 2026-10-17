import { hasApiKeyScope } from '@lobechat/const/apiKeyScope';
import type { LobeChatDatabase } from '@lobechat/database';
import {
  agentOperations,
  apiKeys,
  oidcClients,
  oidcGrants,
  oidcSessions,
  session,
} from '@lobechat/database/schemas';
import { requireTenantScope } from '@lobechat/database/tenant';
import { and, eq, sql } from 'drizzle-orm';

import { getServerDB } from '@/database/core/db-adaptor';
import { hasActiveWorkspaceMembership, hasWorkspaceAdminAccess } from '@/database/models/workspace';
import { assertOIDCUserActive, isOIDCUserInactiveError } from '@/libs/oidc-provider/access-control';
import { redisService } from '@/server/services/redis';

import { gatewayOIDCClients } from './oidcProjection';
import type { GatewayAuthorizationSource, GatewayPrincipal } from './types';
import { GatewayAuthorizationError } from './wire';

const deny = (): never => {
  throw new GatewayAuthorizationError('UNAUTHORIZED');
};
const exists = <T>(row: T | undefined): T => row ?? deny();
const validUntil = (value: Date | null | undefined, now: number) => value && value.getTime() > now;

/** Every call reads the exact source rows; no cookie cache, secondary session cache or another grant substitutes. */
export const assertGatewaySource = async (
  source: GatewayAuthorizationSource,
  resource: {
    operationId?: string;
    principal: GatewayPrincipal;
    enroller?: boolean;
    execute?: boolean;
  },
  db?: LobeChatDatabase,
): Promise<number> => {
  const database = db ?? (await getServerDB());
  const now = Date.now();
  try {
    await assertOIDCUserActive(database, source.subject);
  } catch (error) {
    if (isOIDCUserInactiveError(error)) throw new GatewayAuthorizationError('UNAUTHORIZED');
    throw new GatewayAuthorizationError('GATEWAY_AUTHORITY_UNAVAILABLE', 503);
  }
  let expiresAt = now + 300_000;
  switch (source.kind) {
    case 'session': {
      const [found] = await database
        .select({ expiresAt: session.expiresAt })
        .from(session)
        .where(and(eq(session.id, source.sessionId), eq(session.userId, source.subject)))
        .limit(1);
      const row = exists(found);
      if (!validUntil(row.expiresAt, now)) deny();
      expiresAt = row.expiresAt.getTime();
      break;
    }
    case 'apiKey': {
      const [found] = await database
        .select({
          enabled: apiKeys.enabled,
          expiresAt: apiKeys.expiresAt,
          scopes: apiKeys.scopes,
          keyHash: apiKeys.keyHash,
          workspaceId: apiKeys.workspaceId,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, source.keyId), eq(apiKeys.userId, source.subject)))
        .limit(1);
      const row = exists(found);
      if (
        !row.enabled ||
        row.keyHash !== source.keyHash ||
        row.workspaceId !== (source.workspaceId ?? null) ||
        (row.expiresAt && !validUntil(row.expiresAt, now))
      )
        deny();
      const full = row.scopes === null || row.scopes.includes('*');
      if (
        !full &&
        (!resource.operationId || resource.execute || !hasApiKeyScope(row.scopes, 'chat:read'))
      )
        throw new GatewayAuthorizationError('FORBIDDEN', 403);
      if (
        source.workspaceId &&
        !resource.operationId &&
        (resource.principal.kind !== 'workspace' || resource.principal.id !== source.workspaceId)
      )
        throw new GatewayAuthorizationError('FORBIDDEN', 403);
      expiresAt = row.expiresAt?.getTime() ?? expiresAt;
      break;
    }
    case 'oidc': {
      const projection = await redisService.gatewayAuthorization.getOIDCProjection(source.jti);
      if (!projection) throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
      if (
        projection.tenantId !== requireTenantScope().tenantId ||
        projection.subject !== source.subject ||
        projection.accessTokenExpiresAt <= now
      )
        deny();
      const [found] = await database
        .select({ expiresAt: oidcGrants.expiresAt, clientId: oidcGrants.clientId })
        .from(oidcGrants)
        .where(and(eq(oidcGrants.id, projection.grantId), eq(oidcGrants.userId, source.subject)))
        .limit(1);
      const grant = exists(found);
      if (!validUntil(grant.expiresAt, now) || grant.clientId !== projection.clientId) deny();
      const [client] = await database
        .select({ enabled: oidcClients.enabled })
        .from(oidcClients)
        .where(eq(oidcClients.id, projection.clientId))
        .limit(1);
      if (
        projection.clientAuthority === 'database'
          ? !client?.enabled
          : projection.clientAuthority !== 'static' ||
            (client ? !client.enabled : !gatewayOIDCClients.has(projection.clientId))
      )
        deny();
      if (projection.boundSessionUid) {
        const [bound] = await database
          .select({ expiresAt: oidcSessions.expiresAt })
          .from(oidcSessions)
          .where(
            and(
              sql`${oidcSessions.data}->>'uid' = ${projection.boundSessionUid}`,
              eq(oidcSessions.userId, source.subject),
            ),
          )
          .limit(1);
        if (!bound || !validUntil(bound.expiresAt, now)) deny();
        expiresAt = Math.min(expiresAt, bound.expiresAt.getTime());
      }
      expiresAt = Math.min(expiresAt, projection.accessTokenExpiresAt, grant.expiresAt.getTime());
      break;
    }
    case 'operation': {
      if (resource.operationId && resource.operationId !== source.operationId) deny();
      const [row] = await database
        .select({ status: agentOperations.status, metadata: agentOperations.metadata })
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.id, source.operationId),
            eq(agentOperations.userId, source.subject),
          ),
        )
        .limit(1);
      if (
        !row ||
        !['running', 'waiting_for_human', 'waiting_for_async_tool', 'waiting_for_client'].includes(
          row.status,
        )
      )
        deny();
      if (
        row.metadata?.tenantId !== requireTenantScope().tenantId ||
        row.metadata?.sourceAcceptedVersion !== requireTenantScope().acceptedVersion
      )
        throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_STALE', 409);
      break;
    }
  }
  if (resource.principal.kind === 'user') {
    if (resource.principal.id !== source.subject)
      throw new GatewayAuthorizationError('FORBIDDEN', 403);
  } else {
    const check = resource.enroller ? hasWorkspaceAdminAccess : hasActiveWorkspaceMembership;
    if (!(await check(database, { userId: source.subject, workspaceId: resource.principal.id })))
      throw new GatewayAuthorizationError('FORBIDDEN', 403);
  }
  if (resource.operationId) {
    const [row] = await database
      .select({
        userId: agentOperations.userId,
        workspaceId: agentOperations.workspaceId,
        metadata: agentOperations.metadata,
        status: agentOperations.status,
        parentOperationId: agentOperations.parentOperationId,
      })
      .from(agentOperations)
      .where(eq(agentOperations.id, resource.operationId))
      .limit(1);
    if (
      !row ||
      row.userId !== source.subject ||
      (row.metadata?.streamOwnerUserId && row.metadata.streamOwnerUserId !== source.subject)
    )
      throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
    if (source.kind === 'apiKey' && source.workspaceId && row.workspaceId !== source.workspaceId)
      throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
    if (
      resource.execute &&
      !['running', 'waiting_for_human', 'waiting_for_async_tool', 'waiting_for_client'].includes(
        row.status,
      )
    )
      deny();
    if (resource.execute && row.parentOperationId) {
      const [parent] = await database
        .select({ status: agentOperations.status })
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.id, row.parentOperationId),
            eq(agentOperations.userId, source.subject),
          ),
        )
        .limit(1);
      if (
        !parent ||
        !['running', 'waiting_for_human', 'waiting_for_async_tool', 'waiting_for_client'].includes(
          parent.status,
        )
      )
        deny();
    }
    if (
      row.workspaceId &&
      !(await hasActiveWorkspaceMembership(database, {
        userId: source.subject,
        workspaceId: row.workspaceId,
      }))
    )
      throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
  }
  return expiresAt;
};
