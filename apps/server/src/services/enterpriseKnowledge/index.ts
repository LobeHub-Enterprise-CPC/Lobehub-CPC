import {
  type EnterpriseKbAccess,
  type EnterpriseKbAccessLevel,
  isEnterpriseKnowledgeEnabled,
  listAccessibleEnterpriseKbs,
  listEnterpriseKbIds,
  recordEnterpriseKbItemUploaders,
  resolveEnterpriseKbAccess,
} from '@lobechat/business-knowledge';
import type { EnterpriseKnowledgeBaseInfo, KnowledgeBaseItem } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { KnowledgeBaseModel } from '@/database/models/knowledgeBase';
import { documents, files, knowledgeBaseFiles, knowledgeBases, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { classifyEnterpriseContentIds } from './contentClassification';
import { type EnterpriseNodeAccess, nodeLevel, resolveNodeAccess } from './nodeAccess';

/**
 * Enterprise knowledge bases: one place that answers "may this caller touch
 * this knowledge base / these files, and as whom do I read and write".
 *
 * An enterprise knowledge base is an ordinary personal knowledge base owned by
 * one member (`userId = ownerId`); every row inside it carries that owner id.
 * A non-owner therefore never reads through their own scope: the caller's tier
 * is decided first (`resolveEnterpriseKbAccess`), and only then is the data
 * touched with the owner's id as the scope — after the target has been proven
 * to belong to the very knowledge base the tier was granted for.
 *
 * Denials are NOT_FOUND (the knowledge base is not disclosed), except a caller
 * who can see the knowledge base but lacks the tier for a write: FORBIDDEN.
 * Any error while deciding is a denial.
 */

const TIER_RANK: Record<EnterpriseKbAccessLevel, number> = {
  path: 0,
  edit: 2,
  owner: 3,
  view: 1,
};

export interface EnterpriseAccessCtx {
  serverDB: LobeChatDatabase;
  userId: string;
  workspaceId?: string | null;
}

/** The target is not governed by an enterprise knowledge base: run the ordinary path unchanged. */
export interface PlainScope {
  enterprise: false;
}

/** The target lives in an enterprise knowledge base the caller may use at the required tier. */
export interface EnterpriseScope {
  enterprise: true;
  hasNodePolicies?: boolean;
  knowledgeBaseId: string;
  /** The tier the caller actually holds (>= the required tier). */
  level: EnterpriseKbAccessLevel;
  nodeAccess?: EnterpriseNodeAccess;
  /** Scope every read and write by this user id (`knowledge_bases.user_id`). */
  ownerId: string;
}

export type KnowledgeAccessScope = PlainScope | EnterpriseScope;

const notFound = (message = 'Knowledge base not found') =>
  new TRPCError({ code: 'NOT_FOUND', message });

const forbidden = (message: string) => new TRPCError({ code: 'FORBIDDEN', message });

/** Enterprise sharing only exists for personal-mode data (`workspace_id IS NULL`). */
const isPersonalMode = (ctx: Pick<EnterpriseAccessCtx, 'workspaceId'>) => !ctx.workspaceId;

/**
 * Resolve the caller's access to one knowledge base. A throw while deciding is
 * a denial, so it is reported as an enterprise knowledge base the caller may
 * not see.
 */
const resolveAccess = async (
  db: LobeChatDatabase,
  userId: string,
  knowledgeBaseId: string,
): Promise<{ access: EnterpriseKbAccess | null; enterprise: boolean }> => {
  try {
    const resolution = await resolveEnterpriseKbAccess(db, userId, knowledgeBaseId);
    if (!resolution.enterprise) return { access: null, enterprise: false };
    if (
      resolution.access &&
      (resolution.access.knowledgeBaseId !== knowledgeBaseId ||
        !resolution.access.ownerId ||
        !(resolution.access.level in TIER_RANK) ||
        (resolution.access.level === 'path' && !resolution.access.hasNodePolicies))
    )
      return { access: null, enterprise: true };
    return { access: resolution.access, enterprise: true };
  } catch (error) {
    console.error('[enterpriseKnowledge] access resolution failed, denying', error);
    return { access: null, enterprise: true };
  }
};

/**
 * Gate a request addressed to a knowledge base id.
 *
 * - not an enterprise knowledge base: `{ enterprise: false }`, nothing else runs;
 * - no access: NOT_FOUND; a tier below `required`: FORBIDDEN;
 * - otherwise the scope to read and write with.
 */
export const resolveKnowledgeBaseScope = async (
  ctx: EnterpriseAccessCtx,
  knowledgeBaseId: string,
  required: EnterpriseKbAccessLevel,
  nodeId?: string | null,
): Promise<KnowledgeAccessScope> => {
  if (!isPersonalMode(ctx)) return { enterprise: false };

  const { access, enterprise } = await resolveAccess(ctx.serverDB, ctx.userId, knowledgeBaseId);
  if (!enterprise) return { enterprise: false };
  if (!access || access.knowledgeBaseId !== knowledgeBaseId) throw notFound();
  const nodeAccess = await resolveNodeAccess(ctx.serverDB, ctx.userId, access);
  const level = nodeLevel(access, nodeAccess, nodeId);
  if (!level) throw notFound();
  if (TIER_RANK[level] < TIER_RANK[required]) {
    if (level === 'path') throw notFound();
    throw forbidden(
      required === 'owner'
        ? 'Only the knowledge base owner can do this'
        : 'You do not have edit access to this node',
    );
  }
  return {
    enterprise: true,
    knowledgeBaseId,
    level,
    ownerId: access.ownerId,
    nodeAccess,
    hasNodePolicies: access.hasNodePolicies,
  };
};

/**
 * Reject an operation no enterprise knowledge base allows to anyone (deleting
 * or moving/copying the whole library). Non-enterprise targets pass through.
 */
export const assertNotEnterpriseKnowledgeBase = async (
  ctx: EnterpriseAccessCtx,
  knowledgeBaseId: string,
  message = 'This operation is not allowed on an enterprise knowledge base',
): Promise<void> => {
  const scope = await resolveKnowledgeBaseScope(ctx, knowledgeBaseId, 'path');
  if (scope.enterprise) throw forbidden(message);
};

/**
 * Reject moving or copying a library whose linked files or documents also live in
 * an enterprise knowledge base: the move would rehome them (and copy would
 * duplicate them) outside enterprise policy. Classification failure refuses.
 */
export const assertNoLinkedEnterpriseContent = async (
  ctx: EnterpriseAccessCtx,
  knowledgeBaseId: string,
  message: string,
): Promise<void> => {
  if (ctx.workspaceId || !isEnterpriseKnowledgeEnabled()) return;
  const [linkedFiles, linkedDocuments] = await Promise.all([
    ctx.serverDB
      .select({ id: knowledgeBaseFiles.fileId })
      .from(knowledgeBaseFiles)
      .where(eq(knowledgeBaseFiles.knowledgeBaseId, knowledgeBaseId)),
    ctx.serverDB
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.knowledgeBaseId, knowledgeBaseId)),
  ]);
  const ids = [...linkedFiles, ...linkedDocuments].map((row) => row.id);
  if ((await classifyEnterpriseContentIds(ctx, ids)).size > 0) throw forbidden(message);
};

interface ItemMembership {
  isDeleted: boolean | null;
  knowledgeBaseIds: Set<string>;
  userId: string;
}

/**
 * Who owns each file / document id and which knowledge bases hold it. Looked up
 * without any ownership predicate — the whole point is to learn where an id
 * lives before deciding whose scope may read it.
 */
export const loadItemMemberships = async (
  db: LobeChatDatabase,
  ids: string[],
): Promise<Map<string, ItemMembership>> => {
  const result = new Map<string, ItemMembership>();
  const fileIds = ids;
  const documentIds = ids;
  const add = (
    id: string,
    userId: string,
    knowledgeBaseId: string | null,
    isDeleted: boolean | null,
  ) => {
    const entry = result.get(id) ?? { knowledgeBaseIds: new Set<string>(), userId, isDeleted };
    if (knowledgeBaseId) entry.knowledgeBaseIds.add(knowledgeBaseId);
    result.set(id, entry);
  };

  if (fileIds.length > 0) {
    const rows = await db
      .select({
        id: files.id,
        knowledgeBaseId: knowledgeBaseFiles.knowledgeBaseId,
        userId: files.userId,
        isDeleted: files.isDeleted,
      })
      .from(files)
      .leftJoin(knowledgeBaseFiles, eq(knowledgeBaseFiles.fileId, files.id))
      .where(inArray(files.id, fileIds));
    for (const row of rows) add(row.id, row.userId, row.knowledgeBaseId, row.isDeleted);
  }

  if (documentIds.length > 0) {
    const rows = await db
      .select({
        fileId: documents.fileId,
        id: documents.id,
        knowledgeBaseId: documents.knowledgeBaseId,
        userId: documents.userId,
        isDeleted: documents.isDeleted,
      })
      .from(documents)
      .where(inArray(documents.id, documentIds));
    for (const row of rows) {
      add(row.id, row.userId, row.knowledgeBaseId, row.isDeleted);
    }

    // A parsed file's page belongs to every knowledge base its file is filed in.
    const backingFileIds = rows.map((row) => row.fileId).filter((id): id is string => !!id);
    if (backingFileIds.length > 0) {
      const links = await db
        .select({
          fileId: knowledgeBaseFiles.fileId,
          knowledgeBaseId: knowledgeBaseFiles.knowledgeBaseId,
        })
        .from(knowledgeBaseFiles)
        .where(inArray(knowledgeBaseFiles.fileId, backingFileIds));
      for (const row of rows) {
        if (!row.fileId) continue;
        for (const link of links) {
          if (link.fileId === row.fileId) {
            add(row.id, row.userId, link.knowledgeBaseId, row.isDeleted);
          }
        }
      }
    }
  }

  return result;
};

/**
 * Gate a request addressed to file ids and/or document ids (`docs_*`).
 *
 * The ids are never trusted: each one is looked up, and must either be the
 * caller's own row (the ordinary path, nothing changes) or live in an
 * enterprise knowledge base the caller holds the required tier on. A row owned
 * by someone else that is not in such a knowledge base — the owner's personal
 * file, or a file in another enterprise knowledge base the caller cannot use —
 * is NOT_FOUND. A batch must be homogeneous: it cannot mix the caller's own
 * rows with an owner's, or span two owners.
 *
 * Ids that do not exist at all are left to the ordinary path.
 */
export const resolveItemsScope = async (
  ctx: EnterpriseAccessCtx,
  ids: string[],
  required: EnterpriseKbAccessLevel,
  includeTrashed = false,
): Promise<KnowledgeAccessScope> => {
  if (!isPersonalMode(ctx) || ids.length === 0 || !isEnterpriseKnowledgeEnabled()) {
    return { enterprise: false };
  }

  const uniqueIds = [...new Set(ids)];
  const memberships = await loadItemMemberships(ctx.serverDB, uniqueIds);
  const candidateKbIds = new Set<string>();
  for (const membership of memberships.values()) {
    for (const kbId of membership.knowledgeBaseIds) candidateKbIds.add(kbId);
  }
  // Preserve every non-enterprise path, including its existing not-found behavior.
  if (candidateKbIds.size === 0) {
    if ([...memberships.values()].some((item) => item.userId !== ctx.userId)) throw notFound();
    return { enterprise: false };
  }

  let enterpriseKbIds: string[];
  try {
    enterpriseKbIds = await listEnterpriseKbIds(ctx.serverDB, [...candidateKbIds]);
  } catch (error) {
    console.error('[enterpriseKnowledge] enterprise lookup failed, denying', error);
    throw notFound('Not found');
  }
  const enterpriseSet = new Set(enterpriseKbIds);
  if (enterpriseSet.size === 0) {
    if ([...memberships.values()].some((item) => item.userId !== ctx.userId)) throw notFound();
    return { enterprise: false };
  }

  const accessByKb = new Map<string, EnterpriseKbAccess | null>();
  for (const kbId of enterpriseSet) {
    accessByKb.set(kbId, (await resolveAccess(ctx.serverDB, ctx.userId, kbId)).access);
  }

  const snapshots = new Map<string, EnterpriseNodeAccess | undefined>();
  for (const [kbId, access] of accessByKb) {
    if (access) snapshots.set(kbId, await resolveNodeAccess(ctx.serverDB, ctx.userId, access));
  }
  let scope: EnterpriseScope | undefined;
  let tooLow = false;
  for (const id of uniqueIds) {
    const membership = memberships.get(id);
    if (!membership || (membership.isDeleted && !includeTrashed)) throw notFound('Not found');
    let best:
      | { access: EnterpriseKbAccess; knowledgeBaseId: string; level: EnterpriseKbAccessLevel }
      | undefined;
    for (const kbId of membership.knowledgeBaseIds) {
      const access = accessByKb.get(kbId);
      // The row must carry the owner id of the very knowledge base that grants the tier.
      if (!access || access.ownerId !== membership.userId) continue;
      const level = nodeLevel(access, snapshots.get(kbId), id);
      if (!level) continue;
      if (!best || TIER_RANK[level] > TIER_RANK[best.level]) {
        best = { access, knowledgeBaseId: kbId, level };
      }
    }
    if (!best) throw notFound('Not found');
    if (scope && scope.ownerId !== best.access.ownerId) throw notFound('Not found');
    if (best.level === 'path' && required !== 'path') throw notFound('Not found');
    if (TIER_RANK[best.level] < TIER_RANK[required]) tooLow = true;
    scope ??= {
      enterprise: true,
      knowledgeBaseId: best.knowledgeBaseId,
      level: best.level,
      nodeAccess: snapshots.get(best.knowledgeBaseId),
      hasNodePolicies: best.access.hasNodePolicies,
      ownerId: best.access.ownerId,
    };
    if (TIER_RANK[best.level] < TIER_RANK[scope.level]) scope.level = best.level;
  }

  if (tooLow) throw forbidden('You do not have edit access to this knowledge base');
  return scope!;
};

/**
 * Whether every given file / document id exists and sits inside the given
 * knowledge base — the guard for ids a member names against a library, and for
 * the parent folder they pick for an upload or a move.
 */
export const itemsBelongToKnowledgeBase = async (
  db: LobeChatDatabase,
  itemIds: string[],
  knowledgeBaseId: string,
): Promise<boolean> => {
  const uniqueIds = [...new Set(itemIds)];
  const memberships = await loadItemMemberships(db, uniqueIds);
  return uniqueIds.every((id) => memberships.get(id)?.knowledgeBaseIds.has(knowledgeBaseId));
};

export const getUserDisplayNames = async (
  db: LobeChatDatabase,
  userIds: string[],
): Promise<Map<string, string>> => {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      email: users.email,
      fullName: users.fullName,
      id: users.id,
      username: users.username,
    })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((row) => [row.id, row.fullName || row.username || row.email || row.id]));
};

/** Remember who actually uploaded or created rows that are stored under the owner. */
export const recordMemberUploads = async (
  ctx: EnterpriseAccessCtx,
  knowledgeBaseId: string,
  itemIds: string[],
): Promise<void> => {
  if (itemIds.length === 0) return;
  const name = (await getUserDisplayNames(ctx.serverDB, [ctx.userId])).get(ctx.userId);
  const actor = { id: ctx.userId, kind: 'member' as const, name: name ?? ctx.userId };
  await recordEnterpriseKbItemUploaders(
    ctx.serverDB,
    itemIds.map((itemId) => ({ actor, itemId, knowledgeBaseId })),
  );
};

type KnowledgeBaseWithEnterprise = KnowledgeBaseItem & { enterprise?: EnterpriseKnowledgeBaseInfo };

const safeListAccessible = async (db: LobeChatDatabase, userId: string) => {
  try {
    const candidates = await listAccessibleEnterpriseKbs(db, userId);
    const current: EnterpriseKbAccess[] = [];
    for (const candidate of candidates) {
      const { access } = await resolveAccess(db, userId, candidate.knowledgeBaseId);
      if (access) {
        const nodeAccess = await resolveNodeAccess(db, userId, access);
        const level = nodeLevel(access, nodeAccess);
        if (level) current.push({ ...access, level });
      }
    }
    return current;
  } catch (error) {
    console.error('[enterpriseKnowledge] listing accessible knowledge bases failed', error);
    return [];
  }
};

/**
 * Every enterprise knowledge base the caller can open, own ones included, as
 * ordinary knowledge base items carrying `enterprise: { accessLevel, ownerName }`.
 */
export const listAccessibleEnterpriseKnowledgeBases = async (
  ctx: EnterpriseAccessCtx,
  options?: { visibility?: 'private' | 'public' },
): Promise<KnowledgeBaseWithEnterprise[]> => {
  if (!isPersonalMode(ctx)) return [];

  const accessible = await safeListAccessible(ctx.serverDB, ctx.userId);
  if (accessible.length === 0) return [];

  const ownerIds = [...new Set(accessible.map((item) => item.ownerId))];
  const [names, perOwner] = await Promise.all([
    getUserDisplayNames(ctx.serverDB, ownerIds),
    Promise.all(
      ownerIds.map((ownerId) =>
        new KnowledgeBaseModel(ctx.serverDB, ownerId).query({ visibility: options?.visibility }),
      ),
    ),
  ]);
  const rows = new Map(perOwner.flat().map((item) => [item.id, item]));

  const result: KnowledgeBaseWithEnterprise[] = [];
  for (const item of accessible) {
    const row = rows.get(item.knowledgeBaseId);
    // The row must still belong to the owner the policy names.
    if (!row || row.userId !== item.ownerId) continue;
    result.push({
      ...row,
      enterprise: {
        accessLevel: item.level,
        ownerName: names.get(item.ownerId) ?? item.ownerId,
      },
    });
  }
  return result;
};

/**
 * `items` (the caller's own knowledge bases) plus the enterprise knowledge
 * bases shared with the caller; the ones the caller owns gain `enterprise`.
 */
export const mergeEnterpriseKnowledgeBases = async <T extends KnowledgeBaseItem>(
  ctx: EnterpriseAccessCtx,
  items: T[],
  options?: { visibility?: 'private' | 'public' },
): Promise<(T | KnowledgeBaseWithEnterprise)[]> => {
  const enterpriseItems = await listAccessibleEnterpriseKnowledgeBases(ctx, options);
  const enterpriseIds = new Set(
    await filterEnterpriseKnowledgeBaseIds(
      ctx.serverDB,
      items.map((item) => item.id),
    ),
  );
  if (enterpriseItems.length === 0) return items.filter((item) => !enterpriseIds.has(item.id));

  const byId = new Map(enterpriseItems.map((item) => [item.id, item]));
  const merged: (T | KnowledgeBaseWithEnterprise)[] = items
    .filter((item) => !enterpriseIds.has(item.id) || byId.has(item.id))
    .map((item) => {
      const match = byId.get(item.id);
      if (match) byId.delete(item.id);
      return match ? { ...item, enterprise: match.enterprise } : item;
    });
  merged.push(...byId.values());
  return merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
};

/** Enterprise knowledge bases among `ids`; fails closed (reports all of them) on error. */
export const filterEnterpriseKnowledgeBaseIds = async (
  db: LobeChatDatabase,
  ids: string[],
): Promise<string[]> => {
  if (ids.length === 0) return [];
  try {
    return await listEnterpriseKbIds(db, ids);
  } catch (error) {
    console.error(
      '[enterpriseKnowledge] enterprise lookup failed, treating all as enterprise',
      error,
    );
    return ids;
  }
};

/** Exclude denied enterprise libraries from caller-wide lists/search, including owner reads on policy failure. */
export const getInaccessibleEnterpriseKnowledgeBaseIds = async (
  ctx: EnterpriseAccessCtx,
): Promise<string[]> => {
  if (ctx.workspaceId || !isEnterpriseKnowledgeEnabled()) return [];
  let ids: string[];
  try {
    ids = await listEnterpriseKbIds(ctx.serverDB);
  } catch (error) {
    console.error('[enterpriseKnowledge] cannot scope a global list, denying', error);
    throw notFound();
  }
  const denied: string[] = [];
  for (const id of ids) {
    try {
      await resolveKnowledgeBaseScope(ctx, id, 'path');
    } catch {
      denied.push(id);
    }
  }
  return denied;
};

export interface RetrievalPlan {
  /** Enterprise knowledge bases the asker may search, grouped by the owner whose scope to use. */
  enterpriseGroups: {
    knowledgeBaseIds: string[];
    ownerId: string;
    nodeAccess?: EnterpriseNodeAccess;
  }[];
  /** Knowledge bases to search with the caller's own scope, exactly as before. */
  plainIds: string[];
  /** Enterprise knowledge bases left out; surfaced to the caller as a count only. */
  skippedCount: number;
}

/**
 * Split a retrieval request by the ACTUAL asker. `askerId` is null for share
 * visitors, anonymous and unidentifiable callers: they never search enterprise
 * knowledge bases, even when the run's own user happens to be the owner.
 */
export const planRetrieval = async (
  ctx: Omit<EnterpriseAccessCtx, 'userId'>,
  knowledgeBaseIds: string[],
  askerId: string | null,
): Promise<RetrievalPlan> => {
  if (!isPersonalMode(ctx) || knowledgeBaseIds.length === 0) {
    return { enterpriseGroups: [], plainIds: knowledgeBaseIds, skippedCount: 0 };
  }

  const enterpriseIds = new Set(
    await filterEnterpriseKnowledgeBaseIds(ctx.serverDB, knowledgeBaseIds),
  );
  const plainIds = knowledgeBaseIds.filter((id) => !enterpriseIds.has(id));

  const groups: RetrievalPlan['enterpriseGroups'] = [];
  let skippedCount = 0;
  for (const kbId of enterpriseIds) {
    const { access } = askerId
      ? await resolveAccess(ctx.serverDB, askerId, kbId)
      : { access: null };
    if (!access) {
      skippedCount += 1;
      continue;
    }
    try {
      const nodeAccess = await resolveNodeAccess(ctx.serverDB, askerId!, access);
      groups.push({ knowledgeBaseIds: [kbId], ownerId: access.ownerId, nodeAccess });
    } catch {
      skippedCount += 1;
    }
  }

  return {
    enterpriseGroups: groups,
    plainIds,
    skippedCount,
  };
};

/** The knowledge bases (by id) an owner's scope can read — used to confirm a row is the owner's. */
export const findKnowledgeBaseOwned = async (
  db: LobeChatDatabase,
  knowledgeBaseId: string,
  ownerId: string,
) => {
  const [row] = await db
    .select()
    .from(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, knowledgeBaseId),
        eq(knowledgeBases.userId, ownerId),
        isNull(knowledgeBases.workspaceId),
      ),
    )
    .limit(1);
  return row;
};
