import {
  estimateEnterpriseKbAccess,
  getEnterpriseKbAccessState,
  getEnterpriseKbDirectory,
  listAccessibleEnterpriseKbs,
  listEnterpriseKbEvents,
  updateEnterpriseKbAccess,
} from '@lobechat/business-knowledge';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import type { LobeChatDatabase } from '@/database/type';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  findKnowledgeBaseOwned,
  getUserDisplayNames,
  resolveKnowledgeBaseScope,
} from '@/server/services/enterpriseKnowledge';

const grant = z.object({
  accessLevel: z.enum(['view', 'edit']),
  principalId: z.string().min(1),
  principalType: z.enum(['department', 'user']),
});
const libraryInput = z.object({ knowledgeBaseId: z.string().min(1) });

const ownerProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  if (ctx.workspaceId) throw new TRPCError({ code: 'NOT_FOUND' });
  const raw = await opts.getRawInput();
  const parsed = libraryInput.safeParse(raw);
  try {
    if (parsed.success) {
      const scope = await resolveKnowledgeBaseScope(ctx, parsed.data.knowledgeBaseId, 'view');
      if (
        !scope.enterprise ||
        scope.level !== 'owner' ||
        scope.ownerId !== ctx.userId ||
        !(await findKnowledgeBaseOwned(ctx.serverDB, parsed.data.knowledgeBaseId, ctx.userId))
      )
        throw new TRPCError({ code: 'NOT_FOUND' });
    } else {
      // directory has no library id in the contract: require at least one currently owned enterprise library.
      const candidates = await listAccessibleEnterpriseKbs(ctx.serverDB, ctx.userId);
      let owner = false;
      for (const candidate of candidates.filter((item) => item.level === 'owner')) {
        const scope = await resolveKnowledgeBaseScope(ctx, candidate.knowledgeBaseId, 'view');
        if (
          scope.enterprise &&
          scope.level === 'owner' &&
          scope.ownerId === ctx.userId &&
          (await findKnowledgeBaseOwned(ctx.serverDB, candidate.knowledgeBaseId, ctx.userId))
        ) {
          owner = true;
          break;
        }
      }
      if (!owner) throw new TRPCError({ code: 'NOT_FOUND' });
    }
  } catch {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
  return opts.next();
});

export const enterpriseKnowledgeRouter = router({
  directory: ownerProcedure
    .input(z.object({ keyword: z.string().optional() }))
    .query(({ ctx, input }) => getEnterpriseKbDirectory(ctx.serverDB, input)),
  estimateAccess: ownerProcedure
    .input(libraryInput.extend({ grants: z.array(grant) }))
    .query(({ ctx, input }) => estimateEnterpriseKbAccess(ctx.serverDB, input)),
  getAccess: ownerProcedure
    .input(libraryInput)
    .query(({ ctx, input }) => getEnterpriseKbAccessState(ctx.serverDB, input.knowledgeBaseId)),
  listEvents: ownerProcedure
    .input(libraryInput.extend({ limit: z.number().int().min(1).max(200).optional() }))
    .query(({ ctx, input }) => listEnterpriseKbEvents(ctx.serverDB, input)),
  updateAccess: ownerProcedure
    .input(libraryInput.extend({ grants: z.array(grant), version: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const name =
        (await getUserDisplayNames(ctx.serverDB, [ctx.userId])).get(ctx.userId) ?? ctx.userId;
      try {
        return await ctx.serverDB.transaction(async (tx) =>
          updateEnterpriseKbAccess(tx as unknown as LobeChatDatabase, {
            ...input,
            actor: { id: ctx.userId, kind: 'member', name },
          }),
        );
      } catch (error) {
        if ((error as { code?: string }).code === 'STALE_VERSION')
          throw new TRPCError({ code: 'CONFLICT' });
        if ((error as { code?: string }).code === 'INVALID_PRINCIPAL')
          throw new TRPCError({ code: 'BAD_REQUEST' });
        throw error;
      }
    }),
});
