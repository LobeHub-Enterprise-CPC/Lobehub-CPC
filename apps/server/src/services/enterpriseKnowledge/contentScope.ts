import type { EnterpriseKbAccessLevel } from '@lobechat/business-knowledge';
import { isEnterpriseKnowledgeEnabled } from '@lobechat/business-knowledge';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';

import { DocumentModel } from '@/database/models/document';
import { documents } from '@/database/schemas';

import {
  type EnterpriseAccessCtx,
  itemsBelongToKnowledgeBase,
  type KnowledgeAccessScope,
  resolveItemsScope,
  resolveKnowledgeBaseScope,
} from './index';

/** Only scope-bearing fields. The procedure's full schema still validates its input. */
export const contentTargetSchema = z.object({
  documentId: z.string().optional(),
  fileIds: z.array(z.string()).optional(),
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
  knowledgeBaseId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  slug: z.string().optional(),
});

export type ContentTarget = z.infer<typeof contentTargetSchema>;

/** Slugs are owner-scoped aliases, never file/content identities. */
const resolveDirectoryTarget = async (
  ctx: EnterpriseAccessCtx,
  value: string,
  ownerId?: string,
) => {
  const model = new DocumentModel(ctx.serverDB, ownerId ?? ctx.userId);
  const own = (await model.findBySlug(value)) ?? (await model.findById(value));
  if (own) return own.id;
  if (ownerId) throw new TRPCError({ code: 'NOT_FOUND' });
  const candidates = await ctx.serverDB
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(isNull(documents.workspaceId), or(eq(documents.slug, value), eq(documents.id, value))),
    );
  if (candidates.length > 1) throw new TRPCError({ code: 'NOT_FOUND' });
  return candidates[0]?.id ?? value;
};

/** Resolve both ends of a move before replacing the data scope. Never trust a parent id. */
export const resolveContentScope = async (
  ctx: EnterpriseAccessCtx,
  target: ContentTarget,
  required: EnterpriseKbAccessLevel,
): Promise<KnowledgeAccessScope> => {
  if (ctx.workspaceId || !isEnterpriseKnowledgeEnabled()) return { enterprise: false };
  const kbScope = target.knowledgeBaseId
    ? await resolveKnowledgeBaseScope(ctx, target.knowledgeBaseId, 'path')
    : undefined;
  const ownerId = kbScope?.enterprise ? kbScope.ownerId : undefined;
  const ids =
    target.ids ??
    target.fileIds ??
    [
      target.id ??
        target.documentId ??
        (target.slug ? await resolveDirectoryTarget(ctx, target.slug, ownerId) : undefined),
    ].filter((id): id is string => !!id);
  const itemScope = await resolveItemsScope(ctx, ids, required);
  const parentId = target.parentId
    ? await resolveDirectoryTarget(
        ctx,
        target.parentId,
        ownerId ?? (itemScope.enterprise ? itemScope.ownerId : undefined),
      )
    : undefined;
  const parentScope = parentId
    ? await resolveItemsScope(ctx, [parentId], required === 'edit' ? 'edit' : 'path')
    : { enterprise: false as const };
  const scope = kbScope ?? (itemScope.enterprise ? itemScope : parentScope);
  if (!scope.enterprise) {
    if (itemScope.enterprise || parentScope.enterprise) throw new TRPCError({ code: 'NOT_FOUND' });
    return scope;
  }
  // A create has no target ids, but every explicit target / destination must be in THIS library.
  if (
    !(await itemsBelongToKnowledgeBase(
      ctx.serverDB,
      [...ids, ...(parentId ? [parentId] : [])],
      scope.knowledgeBaseId,
    ))
  ) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
  // Check the exact library, not another library that happens to reference the same file.
  for (const id of ids) await resolveKnowledgeBaseScope(ctx, scope.knowledgeBaseId, required, id);
  if (parentId)
    await resolveKnowledgeBaseScope(
      ctx,
      scope.knowledgeBaseId,
      required === 'edit' ? 'edit' : 'path',
      parentId,
    );
  else if (required === 'edit' && (ids.length === 0 || target.parentId === null))
    await resolveKnowledgeBaseScope(ctx, scope.knowledgeBaseId, 'edit');
  return scope;
};
