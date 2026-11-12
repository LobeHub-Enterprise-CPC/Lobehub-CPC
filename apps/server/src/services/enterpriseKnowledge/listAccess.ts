import { isEnterpriseKnowledgeEnabled } from '@lobechat/business-knowledge';
import type { EnterpriseItemAccess } from '@lobechat/types';

import {
  type EnterpriseAccessCtx,
  type EnterpriseScope,
  filterEnterpriseKnowledgeBaseIds,
  loadItemMemberships,
  resolveKnowledgeBaseScope,
} from './index';
import { nodeLevel } from './nodeAccess';

/** One request-local filter shared across pages. Never reuse permission snapshots across requests. */
export const createEnterpriseListFilter = (
  ctx: EnterpriseAccessCtx,
  knownScope?: EnterpriseScope,
) => {
  const scopes = new Map<string, EnterpriseScope | null>();
  if (knownScope) scopes.set(knownScope.knowledgeBaseId, knownScope);
  return async <T extends { id: string }>(
    rows: T[],
  ): Promise<(T & { enterpriseAccess?: EnterpriseItemAccess })[]> => {
    if (ctx.workspaceId || !isEnterpriseKnowledgeEnabled() || !rows.length) return rows;
    const memberships = await loadItemMemberships(
      ctx.serverDB,
      rows.map((row) => row.id),
    );
    const candidateIds = [
      ...new Set([...memberships.values()].flatMap((row) => [...row.knowledgeBaseIds])),
    ];
    const enterpriseIds = new Set(
      await filterEnterpriseKnowledgeBaseIds(ctx.serverDB, candidateIds),
    );
    for (const id of enterpriseIds) {
      if (scopes.has(id)) continue;
      try {
        const scope = await resolveKnowledgeBaseScope(ctx, id, 'path');
        scopes.set(id, scope.enterprise ? scope : null);
      } catch {
        scopes.set(id, null);
      }
    }
    return rows.flatMap((row) => {
      const membership = memberships.get(row.id);
      if (knownScope && !membership?.knowledgeBaseIds.has(knownScope.knowledgeBaseId)) return [];
      const governedIds = [...(membership?.knowledgeBaseIds ?? [])].filter(
        (id) => enterpriseIds.has(id) && (!knownScope || id === knownScope.knowledgeBaseId),
      );
      if (!governedIds.length) return [row];
      let access: EnterpriseItemAccess | undefined;
      for (const id of governedIds) {
        const scope = scopes.get(id);
        if (!scope || membership?.userId !== scope.ownerId || membership.isDeleted) continue;
        const level = nodeLevel(scope, scope.nodeAccess, row.id);
        if (!level) continue;
        // Only folders may be visible as paths. No file body, preview, URL or metadata on a path.
        if (level === 'path' && scope.nodeAccess?.nodes.get(row.id)?.kind !== 'folder') continue;
        access = {
          level,
          custom:
            level === 'owner' &&
            !!scope.nodeAccess?.customIds.has(
              scope.nodeAccess.nodes.get(row.id)?.aliasOf ?? row.id,
            ),
        };
        break;
      }
      if (!access) return [];
      return [
        {
          ...row,
          ...(access.level === 'path'
            ? {
                content: null,
                contentPreview: null,
                contentPreviewSource: null,
                editorData: null,
                metadata: null,
                url: '',
                size: 0,
              }
            : {}),
          enterpriseAccess: access,
        },
      ];
    });
  };
};

/** Apply pagination to visible rows, so a hidden first page cannot conceal accessible results. */
export const queryEnterprisePage = async <T extends { id: string }>(
  ctx: EnterpriseAccessCtx,
  query: (page: { limit: number; offset: number }) => Promise<T[]>,
  options: {
    limit: number;
    /** Applied before paging so a typed page is filled with matching rows. */
    match?: (row: T) => boolean;
    offset?: number;
    scope?: EnterpriseScope;
  },
): Promise<(T & { enterpriseAccess?: EnterpriseItemAccess })[]> => {
  if (!options.match && (ctx.workspaceId || !isEnterpriseKnowledgeEnabled()))
    return query({ limit: options.limit, offset: options.offset ?? 0 });
  const filter = createEnterpriseListFilter(ctx, options.scope);
  const wanted = (options.offset ?? 0) + options.limit;
  const visible: (T & { enterpriseAccess?: EnterpriseItemAccess })[] = [];
  let offset = 0;
  while (visible.length < wanted) {
    const batch = await query({ limit: 100, offset });
    const permitted =
      ctx.workspaceId || !isEnterpriseKnowledgeEnabled() ? batch : await filter(batch);
    visible.push(...(options.match ? permitted.filter(options.match) : permitted));
    offset += batch.length;
    if (batch.length < 100) break;
  }
  return visible.slice(options.offset ?? 0, wanted);
};
