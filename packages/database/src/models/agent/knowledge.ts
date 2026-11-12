import {
  isEnterpriseKnowledgeEnabled,
  listEnterpriseKbIds,
  resolveEnterpriseKbAccess,
} from '@lobechat/business-knowledge';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { agentsFiles, agentsKnowledgeBases, files, knowledgeBases } from '../../schemas';
import { buildWorkspacePayload, buildWorkspaceWhere } from '../../utils/workspace';
import { type AgentModelContext } from './context';

/**
 * Mounts of enterprise knowledge bases owned by someone else. The ownership join
 * above only matches the caller's own rows, so these come back as bare mounts
 * with no knowledge base. Each one is decided per read, from the caller's
 * current standing: still accessible → the knowledge base row (read through the
 * owner), withdrawn or undecidable → `accessRevoked` with id and name only, so
 * the editor can show it and the caller can unmount it, and retrieval skips it.
 */
const resolveEnterpriseMounts = async (
  ctx: AgentModelContext,
  mounts: { knowledgeBaseId: string; knowledgeBases: unknown; enabled: boolean | null }[],
): Promise<Map<string, unknown>> => {
  const resolved = new Map<string, unknown>();
  if (ctx.workspaceId || !isEnterpriseKnowledgeEnabled()) return resolved;

  const candidateIds = mounts.map((mount) => mount.knowledgeBaseId);
  if (candidateIds.length === 0) return resolved;

  let enterpriseIds: string[];
  try {
    enterpriseIds = await listEnterpriseKbIds(ctx.db, candidateIds);
  } catch (error) {
    console.error('[agent knowledge] enterprise lookup failed, leaving mounts unavailable', error);
    enterpriseIds = candidateIds;
  }
  if (enterpriseIds.length === 0) return resolved;

  const rows = await ctx.db
    .select()
    .from(knowledgeBases)
    .where(and(inArray(knowledgeBases.id, enterpriseIds), isNull(knowledgeBases.workspaceId)));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const kbId of enterpriseIds) {
    const row = rowById.get(kbId);
    if (!row) continue;
    let ownerId: string | undefined;
    try {
      const resolution = await resolveEnterpriseKbAccess(ctx.db, ctx.userId, kbId);
      if (resolution.enterprise && resolution.access && resolution.access.ownerId === row.userId) {
        ownerId = resolution.access.ownerId;
      }
    } catch (error) {
      console.error('[agent knowledge] access resolution failed, denying', error);
    }
    resolved.set(kbId, ownerId ? row : { accessRevoked: true, id: row.id, name: row.name });
  }

  return resolved;
};

export const getAgentAssignedKnowledge = async (ctx: AgentModelContext, id: string) => {
  // The junction tables carry the mount (created by whoever wired the agent
  // to the KB / file); the ownership() predicates below match the caller's
  // own mount rows within the same workspace.
  //
  // The joined `knowledgeBases` / `files` rows also need a visibility guard
  // in the `leftJoin` ON clause: without it, a KB or file that was later
  // flipped back to `private` via `setVisibility` would keep
  // leaking its name / description into every mounted-agent view across the
  // workspace. Enforcing the guard on the ON clause (rather than WHERE)
  // keeps the mount row in the result but nulls out the referenced entity —
  // callers can then treat `id === null` as "unavailable" and render a
  // placeholder in the editor list, while `resolveAgentKnowledgeBaseIds` in
  // the runtime naturally skips such rows via its `k.id` filter.
  const [knowledgeBaseResult, fileResult] = await Promise.all([
    ctx.db
      .select({
        enabled: agentsKnowledgeBases.enabled,
        knowledgeBaseId: agentsKnowledgeBases.knowledgeBaseId,
        knowledgeBases,
      })
      .from(agentsKnowledgeBases)
      .where(and(eq(agentsKnowledgeBases.agentId, id), ctx.agentsKnowledgeBasesOwnership()))
      .orderBy(desc(agentsKnowledgeBases.createdAt))
      .leftJoin(
        knowledgeBases,
        and(
          eq(knowledgeBases.id, agentsKnowledgeBases.knowledgeBaseId),
          buildWorkspaceWhere({ userId: ctx.userId, workspaceId: ctx.workspaceId }, knowledgeBases),
        ),
      ),
    ctx.db
      .select({ enabled: agentsFiles.enabled, files })
      .from(agentsFiles)
      .where(and(eq(agentsFiles.agentId, id), ctx.agentsFilesOwnership()))
      .orderBy(desc(agentsFiles.createdAt))
      .leftJoin(
        files,
        and(
          eq(files.id, agentsFiles.fileId),
          buildWorkspaceWhere({ userId: ctx.userId, workspaceId: ctx.workspaceId }, files),
        ),
      ),
  ]);

  const enterpriseMounts = await resolveEnterpriseMounts(ctx, knowledgeBaseResult);

  return {
    files: fileResult.map((item) => ({
      ...item.files,
      enabled: item.enabled,
    })),
    knowledgeBases: knowledgeBaseResult.map((item) => ({
      ...((enterpriseMounts.get(item.knowledgeBaseId) as
        Partial<typeof item.knowledgeBases> | undefined) ?? item.knowledgeBases),
      enabled: item.enabled,
    })) as Array<
      Partial<NonNullable<(typeof knowledgeBaseResult)[number]['knowledgeBases']>> & {
        accessRevoked?: boolean;
        enabled: boolean;
      }
    >,
  };
};

export const createAgentKnowledgeBase = async (
  ctx: AgentModelContext,
  agentId: string,
  knowledgeBaseId: string,
  enabled: boolean = true,
) => {
  return ctx.db
    .insert(agentsKnowledgeBases)
    .values(
      buildWorkspacePayload(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        { agentId, enabled, knowledgeBaseId },
      ),
    );
};

export const deleteAgentKnowledgeBase = async (
  ctx: AgentModelContext,
  agentId: string,
  knowledgeBaseId: string,
) => {
  return ctx.db
    .delete(agentsKnowledgeBases)
    .where(
      and(
        eq(agentsKnowledgeBases.agentId, agentId),
        eq(agentsKnowledgeBases.knowledgeBaseId, knowledgeBaseId),
        ctx.agentsKnowledgeBasesOwnership(),
      ),
    );
};

export const toggleKnowledgeBase = async (
  ctx: AgentModelContext,
  agentId: string,
  knowledgeBaseId: string,
  enabled?: boolean,
) => {
  return ctx.db
    .update(agentsKnowledgeBases)
    .set({ enabled })
    .where(
      and(
        eq(agentsKnowledgeBases.agentId, agentId),
        eq(agentsKnowledgeBases.knowledgeBaseId, knowledgeBaseId),
        ctx.agentsKnowledgeBasesOwnership(),
      ),
    );
};

export const createAgentFiles = async (
  ctx: AgentModelContext,
  agentId: string,
  fileIds: string[],
  enabled: boolean = true,
) => {
  // Exclude the fileIds that already exist in agentsFiles, and then insert them
  const existingFiles = await ctx.db
    .select({ id: agentsFiles.fileId })
    .from(agentsFiles)
    .where(
      and(
        eq(agentsFiles.agentId, agentId),
        ctx.agentsFilesOwnership(),
        inArray(agentsFiles.fileId, fileIds),
      ),
    );

  const existingFilesIds = new Set(existingFiles.map((item) => item.id));

  const needToInsertFileIds = fileIds.filter((fileId) => !existingFilesIds.has(fileId));

  if (needToInsertFileIds.length === 0) return;

  return ctx.db
    .insert(agentsFiles)
    .values(
      needToInsertFileIds.map((fileId) =>
        buildWorkspacePayload(
          { userId: ctx.userId, workspaceId: ctx.workspaceId },
          { agentId, enabled, fileId },
        ),
      ),
    );
};

export const deleteAgentFile = async (ctx: AgentModelContext, agentId: string, fileId: string) => {
  return ctx.db
    .delete(agentsFiles)
    .where(
      and(
        eq(agentsFiles.agentId, agentId),
        eq(agentsFiles.fileId, fileId),
        ctx.agentsFilesOwnership(),
      ),
    );
};

export const toggleFile = async (
  ctx: AgentModelContext,
  agentId: string,
  fileId: string,
  enabled?: boolean,
) => {
  return ctx.db
    .update(agentsFiles)
    .set({ enabled })
    .where(
      and(
        eq(agentsFiles.agentId, agentId),
        eq(agentsFiles.fileId, fileId),
        ctx.agentsFilesOwnership(),
      ),
    );
};
