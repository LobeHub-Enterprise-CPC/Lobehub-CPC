import {
  estimateEnterpriseKbAccess,
  estimateEnterpriseKbNodeAccess,
  getEnterpriseKbAccessState,
  getEnterpriseKbDirectory,
  getEnterpriseKbNodeAccessState,
  listAccessibleEnterpriseKbs,
  listEnterpriseKbEvents,
  updateEnterpriseKbAccess,
  updateEnterpriseKbNodeAccess,
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
  itemsBelongToKnowledgeBase,
  resolveItemsScope,
  resolveKnowledgeBaseScope,
} from '@/server/services/enterpriseKnowledge';
import { moveEnterpriseContent } from '@/server/services/enterpriseKnowledge/move';
import { getEnterpriseNodeMetadata } from '@/server/services/enterpriseKnowledge/nodeAccess';

const grant = z.object({
  accessLevel: z.enum(['view', 'edit']),
  principalId: z.string().min(1),
  principalType: z.enum(['department', 'user']),
});
const libraryInput = z.object({ knowledgeBaseId: z.string().min(1) });
const nodeInput = libraryInput.extend({ nodeId: z.string().min(1) });
const contentMoveInput = libraryInput.extend({
  ids: z.array(z.string().min(1)).min(1).max(1000),
  parentId: z.string().min(1).nullable().optional(),
});
const nodeChange = nodeInput.extend({
  mode: z.enum(['inherit', 'custom']),
  grants: z.array(grant),
});
const nodeAccessView = async (
  db: LobeChatDatabase,
  userId: string,
  input: z.infer<typeof nodeInput>,
) => {
  const metadata = await getEnterpriseNodeMetadata(db, input.knowledgeBaseId, userId, input.nodeId);
  const state = await getEnterpriseKbNodeAccessState(db, {
    ...input,
    nodeId: metadata.node.id,
    ancestorIds: metadata.ancestorIds,
  });
  const library = await findKnowledgeBaseOwned(db, input.knowledgeBaseId, userId);
  return {
    ...state,
    inheritedFrom: {
      id: state.inheritedFromNodeId,
      name: state.inheritedFromNodeId
        ? (metadata.nodes.get(state.inheritedFromNodeId)?.name ?? '')
        : (library?.name ?? ''),
    },
    node: metadata.node,
  };
};

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
  moveIn: wsCompatProcedure
    .use(serverDatabase)
    .input(contentMoveInput)
    .mutation(({ ctx, input }) => moveEnterpriseContent(ctx, input, 'in')),
  moveOut: wsCompatProcedure
    .use(serverDatabase)
    .input(contentMoveInput)
    .mutation(({ ctx, input }) => moveEnterpriseContent(ctx, input, 'out')),
  resolveLevel: wsCompatProcedure
    .use(serverDatabase)
    .input(libraryInput.extend({ nodeId: z.string().nullable().optional() }))
    .query(async ({ ctx, input }) => {
      const scope = await resolveKnowledgeBaseScope(
        ctx,
        input.knowledgeBaseId,
        'path',
        input.nodeId,
      );
      if (!scope.enterprise) throw new TRPCError({ code: 'NOT_FOUND' });
      if (input.nodeId && !scope.nodeAccess) {
        if (
          !(await itemsBelongToKnowledgeBase(ctx.serverDB, [input.nodeId], input.knowledgeBaseId))
        )
          throw new TRPCError({ code: 'NOT_FOUND' });
        await resolveItemsScope(ctx, [input.nodeId], 'path');
      }
      return { level: scope.level };
    }),
  getNodeAccess: ownerProcedure
    .input(nodeInput)
    .query(({ ctx, input }) => nodeAccessView(ctx.serverDB, ctx.userId, input)),
  estimateNodeAccess: ownerProcedure.input(nodeChange).query(async ({ ctx, input }) => {
    const metadata = await getEnterpriseNodeMetadata(
      ctx.serverDB,
      input.knowledgeBaseId,
      ctx.userId,
      input.nodeId,
    );
    return estimateEnterpriseKbNodeAccess(ctx.serverDB, {
      ...input,
      nodeId: metadata.node.id,
      ancestorIds: metadata.ancestorIds,
    });
  }),
  updateNodeAccess: ownerProcedure
    .input(nodeChange.extend({ version: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const name =
        (await getUserDisplayNames(ctx.serverDB, [ctx.userId])).get(ctx.userId) ?? ctx.userId;
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const db = tx as unknown as LobeChatDatabase;
          const metadata = await getEnterpriseNodeMetadata(
            db,
            input.knowledgeBaseId,
            ctx.userId,
            input.nodeId,
          );
          await updateEnterpriseKbNodeAccess(db, {
            ...input,
            nodeId: metadata.node.id,
            ancestorIds: metadata.ancestorIds,
            nodeKind: metadata.node.kind,
            nodeName: metadata.node.name,
            actor: { id: ctx.userId, kind: 'member', name },
          });
          return nodeAccessView(db, ctx.userId, input);
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'STALE_VERSION')
          throw new TRPCError({ code: 'CONFLICT' });
        if ((error as { code?: string }).code === 'INVALID_PRINCIPAL')
          throw new TRPCError({ code: 'BAD_REQUEST' });
        throw error;
      }
    }),
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
