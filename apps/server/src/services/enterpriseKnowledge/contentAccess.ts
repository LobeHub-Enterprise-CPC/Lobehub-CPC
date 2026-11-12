import {
  isEnterpriseKnowledgeEnabled,
  resolveEnterpriseKbAccess,
} from '@lobechat/business-knowledge';
import { hasApiKeyScope, isFullAccessApiKey } from '@lobechat/const/apiKeyScope';
import { TRPCError } from '@trpc/server';
import { and, inArray, isNull } from 'drizzle-orm';
import pMap from 'p-map';

import { knowledgeBases } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { loadEnterpriseContentMemberships } from './contentClassification';
import { resolveKnowledgeBaseScope } from './index';

/**
 * Caller eligible to read managed content on surfaces that bypass the tRPC credential
 * middleware, such as the file proxy. Managed content is personal-scope: sessions,
 * ordinary OIDC and full-access or `file:read` API keys qualify; sandbox operation
 * tokens and any workspace-bound identity never do.
 */
export const resolveManagedContentReader = (identity: {
  apiKeyScopes?: string[] | null;
  oidcAuth?: object | null;
  userId?: string | null;
  workspaceId?: string | null;
}): string | undefined => {
  if (!identity.userId || identity.workspaceId) return undefined;
  const purpose = (identity.oidcAuth as { purpose?: unknown } | null | undefined)?.purpose;
  if (purpose === 'hetero-operation') return undefined;
  const scopes = identity.apiKeyScopes;
  if (scopes && !isFullAccessApiKey(scopes) && !hasApiKeyScope(scopes, 'file:read'))
    return undefined;
  return identity.userId;
};

interface ContentAccessContext {
  serverDB: LobeChatDatabase;
  /** Authenticated caller, distinct from the data owner's scope. */
  userId?: string | null;
  workspaceId?: string | null;
}

/**
 * Resolve exact enterprise file/document ids before signing URLs or reading bodies.
 * Non-enterprise ids keep the existing model scope (and public-by-id proxy behavior).
 * A granted library never grants access to its owner's unrelated personal content.
 */
export const resolveEnterpriseContentScopes = async (
  ctx: ContentAccessContext,
  ids: string[],
): Promise<Map<string, string>> => {
  const scopes = new Map<string, string>();
  if (ctx.workspaceId || ids.length === 0 || !isEnterpriseKnowledgeEnabled()) return scopes;

  try {
    const { items, enterpriseIds } = await loadEnterpriseContentMemberships(ctx, ids);
    if (enterpriseIds.length === 0) return scopes;
    const libraries = await ctx.serverDB
      .select({
        id: knowledgeBases.id,
        userId: knowledgeBases.userId,
        isDeleted: knowledgeBases.isDeleted,
      })
      .from(knowledgeBases)
      .where(and(inArray(knowledgeBases.id, enterpriseIds), isNull(knowledgeBases.workspaceId)));
    const enterpriseSet = new Set(enterpriseIds);
    const resolutions = new Map(
      await pMap(
        enterpriseIds,
        async (id) =>
          [
            id,
            ctx.userId
              ? await resolveEnterpriseKbAccess(ctx.serverDB, ctx.userId, id)
              : { enterprise: true as const, access: null },
          ] as const,
        { concurrency: 10 },
      ),
    );

    for (const id of ids) {
      const item = items.get(id);
      if (!item) continue;
      const governedIds = [...item.knowledgeBaseIds].filter((kbId) => enterpriseSet.has(kbId));
      if (governedIds.length === 0) continue;
      const permitted =
        !item.isDeleted &&
        (
          await Promise.all(
            governedIds.map(async (kbId) => {
              const resolution = resolutions.get(kbId);
              const library = libraries.find((row) => row.id === kbId);
              const valid =
                resolution?.enterprise &&
                resolution.access &&
                library &&
                !library.isDeleted &&
                resolution.access.knowledgeBaseId === kbId &&
                resolution.access.ownerId === library.userId &&
                library.userId === item.userId &&
                ['owner', 'edit', 'view', 'path'].includes(resolution.access.level);
              if (!valid || !ctx.userId) return false;
              try {
                await resolveKnowledgeBaseScope({ ...ctx, userId: ctx.userId }, kbId, 'view', id);
                return true;
              } catch {
                return false;
              }
            }),
          )
        ).some(Boolean);
      if (!permitted) throw new TRPCError({ code: 'NOT_FOUND' });
      scopes.set(id, item.userId);
    }
    return scopes;
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') throw error;
    console.error('[enterpriseKnowledge] content access resolution failed', error);
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
};
