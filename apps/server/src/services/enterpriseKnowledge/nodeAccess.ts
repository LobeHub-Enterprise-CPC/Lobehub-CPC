import type {
  EnterpriseKbAccess,
  EnterpriseKbAccessLevel,
  EnterpriseKbUserTree,
} from '@lobechat/business-knowledge';
import {
  listEnterpriseKbNodePolicies,
  resolveEnterpriseKbUserTree,
} from '@lobechat/business-knowledge';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { documents, files, knowledgeBaseFiles } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

export interface EnterpriseNode {
  aliasOf?: string | null;
  id: string;
  isDeleted: boolean | null;
  kind: 'document' | 'file' | 'folder';
  name: string;
  parentId: string | null;
}

export interface EnterpriseNodeAccess {
  customIds: Set<string>;
  levels: Map<string, EnterpriseKbAccessLevel | null>;
  nodes: Map<string, EnterpriseNode>;
  rootLevel: EnterpriseKbAccessLevel | null;
}

/** The directory is authoritative. A mirror is an alias, never an independent permission node. */
export const calculateNodeAccess = (
  rows: EnterpriseNode[],
  tree: EnterpriseKbUserTree,
): EnterpriseNodeAccess => {
  const nodes = new Map(rows.map((row) => [row.id, row]));
  const policies = new Map(tree.nodes.map((row) => [row.nodeId, row.level]));
  const levels = new Map<string, EnterpriseKbAccessLevel | null>();
  const valid = new Map<string, boolean>();
  const visiting = new Set<string>();
  const isLive = (id: string): boolean => {
    if (valid.has(id)) return valid.get(id)!;
    const row = nodes.get(id);
    if (!row || row.isDeleted || visiting.has(id)) return false;
    visiting.add(id);
    const live = row.aliasOf
      ? isLive(row.aliasOf)
      : !row.parentId || (nodes.get(row.parentId)?.kind === 'folder' && isLive(row.parentId));
    visiting.delete(id);
    valid.set(id, live);
    return live;
  };
  const level = (id: string): EnterpriseKbAccessLevel | null => {
    if (levels.has(id)) return levels.get(id)!;
    const row = nodes.get(id);
    if (!row) return null;
    const result = tree.owner
      ? 'owner'
      : !isLive(id)
        ? null
        : row.aliasOf
          ? level(row.aliasOf)
          : policies.has(id)
            ? policies.get(id)!
            : row.parentId
              ? level(row.parentId)
              : tree.libraryLevel;
    levels.set(id, result);
    return result;
  };
  for (const row of rows) level(row.id);
  let rootLevel: EnterpriseKbAccessLevel | null = tree.owner ? 'owner' : tree.libraryLevel;
  // Only real granted nodes make their ancestor folders visible; path itself grants no contents.
  for (const row of rows) {
    if (!levels.get(row.id) || row.aliasOf || (!tree.owner && !isLive(row.id))) continue;
    rootLevel ??= 'path';
    let parentId = row.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = nodes.get(parentId);
      if (!parent || parent.kind !== 'folder') break;
      if (!levels.get(parentId)) levels.set(parentId, 'path');
      parentId = parent.parentId;
    }
  }
  return { customIds: new Set(tree.nodes.map((row) => row.nodeId)), levels, nodes, rootLevel };
};

/** Load only when node policies exist, or when an owner API needs trusted node metadata. */
export const loadEnterpriseNodes = async (
  db: LobeChatDatabase,
  knowledgeBaseId: string,
  ownerId: string,
): Promise<EnterpriseNode[]> => {
  const fileRows = await db
    .select({
      id: files.id,
      isDeleted: files.isDeleted,
      name: files.name,
      parentId: files.parentId,
    })
    .from(files)
    .innerJoin(knowledgeBaseFiles, eq(knowledgeBaseFiles.fileId, files.id))
    .where(
      and(
        eq(knowledgeBaseFiles.knowledgeBaseId, knowledgeBaseId),
        eq(files.userId, ownerId),
        isNull(files.workspaceId),
      ),
    );
  const documentRows = await db
    .select({
      id: documents.id,
      fileId: documents.fileId,
      fileType: documents.fileType,
      isDeleted: documents.isDeleted,
      name: documents.title,
      filename: documents.filename,
      sourceType: documents.sourceType,
      parentId: documents.parentId,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, ownerId),
        isNull(documents.workspaceId),
        or(
          eq(documents.knowledgeBaseId, knowledgeBaseId),
          fileRows.length
            ? inArray(
                documents.fileId,
                fileRows.map((row) => row.id),
              )
            : undefined,
        ),
      ),
    );
  const pageByFile = new Map(
    documentRows
      // Every page authored in the library (markdown, HTML, ...) owns its backing file; only
      // parsed mirrors (`sourceType: 'file'`) follow the file instead.
      .filter((row) => row.fileId && row.sourceType !== 'file')
      .map((row) => [row.fileId, row.id]),
  );
  return [
    ...fileRows.map((row) => ({ ...row, kind: 'file' as const, aliasOf: pageByFile.get(row.id) })),
    ...documentRows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      isDeleted: row.isDeleted,
      aliasOf: row.fileId && pageByFile.get(row.fileId) !== row.id ? row.fileId : undefined,
      kind: row.fileType === 'custom/folder' ? ('folder' as const) : ('document' as const),
      name: row.name ?? row.filename ?? row.id,
    })),
  ];
};

export const resolveNodeAccess = async (
  db: LobeChatDatabase,
  userId: string,
  access: EnterpriseKbAccess,
): Promise<EnterpriseNodeAccess | undefined> => {
  if (!access.hasNodePolicies) return undefined;
  try {
    const tree =
      access.level === 'owner'
        ? {
            knowledgeBaseId: access.knowledgeBaseId,
            libraryLevel: null,
            ownerId: access.ownerId,
            owner: true,
            nodes: (await listEnterpriseKbNodePolicies(db, access.knowledgeBaseId)).map(
              (policy) => ({ nodeId: policy.nodeId, level: null }),
            ),
          }
        : await resolveEnterpriseKbUserTree(db, userId, access.knowledgeBaseId);
    if (
      !tree ||
      tree.knowledgeBaseId !== access.knowledgeBaseId ||
      tree.ownerId !== access.ownerId ||
      tree.owner !== (access.level === 'owner')
    )
      throw new Error('Invalid enterprise node tree');
    return calculateNodeAccess(
      await loadEnterpriseNodes(db, access.knowledgeBaseId, access.ownerId),
      tree,
    );
  } catch (error) {
    console.error('[enterpriseKnowledge] node resolution failed, denying', error);
    throw new TRPCError({ code: 'NOT_FOUND' });
  }
};

export const nodeLevel = (
  access: Pick<EnterpriseKbAccess, 'level'>,
  snapshot: EnterpriseNodeAccess | undefined,
  id?: string | null,
) => (snapshot ? (id ? (snapshot.levels.get(id) ?? null) : snapshot.rootLevel) : access.level);

/** Metadata for owner-only policy APIs. Ancestors are nearest first and come only from the DB. */
export const getEnterpriseNodeMetadata = async (
  db: LobeChatDatabase,
  knowledgeBaseId: string,
  ownerId: string,
  nodeId: string,
) => {
  const rows = await loadEnterpriseNodes(db, knowledgeBaseId, ownerId);
  const nodes = new Map(rows.map((row) => [row.id, row]));
  let node = nodes.get(nodeId);
  if (node?.aliasOf) node = nodes.get(node.aliasOf);
  if (!node || node.isDeleted) throw new TRPCError({ code: 'NOT_FOUND' });
  const ancestorIds: string[] = [];
  let parentId = node.parentId;
  while (parentId) {
    const parent = nodes.get(parentId);
    if (
      !parent ||
      parent.isDeleted ||
      parent.kind !== 'folder' ||
      ancestorIds.includes(parentId) ||
      parentId === node.id
    )
      throw new TRPCError({ code: 'NOT_FOUND' });
    ancestorIds.push(parentId);
    parentId = parent.parentId;
  }
  return { ancestorIds, node: { id: node.id, kind: node.kind, name: node.name }, nodes };
};
