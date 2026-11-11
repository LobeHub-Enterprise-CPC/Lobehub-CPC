import type { EnterpriseKbActor } from '@lobechat/business-knowledge';
import { listEnterpriseKbIds } from '@lobechat/business-knowledge';
import { and, eq, isNull } from 'drizzle-orm';

import { type KnowledgeBaseItem, knowledgeBases } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { notTrashed } from '@/database/utils/softDelete';

import { notFound } from './errors';

export interface AdminActor {
  id: string;
  name: string;
}

export const toEnterpriseActor = (actor: AdminActor): EnterpriseKbActor => ({
  id: actor.id,
  kind: 'admin',
  name: actor.name,
});

/** `%keyword%` for ILIKE with the LIKE wildcards in the keyword taken literally. */
export const containsPattern = (keyword: string) => `%${keyword.replaceAll(/[%\\_]/g, '\\$&')}%`;

/**
 * An enterprise knowledge base is a plain personal-scope row that the distribution marked.
 * Anything else (missing, in a workspace, trashed, not marked) is "not found" to the caller.
 */
export const loadEnterpriseKb = async (
  db: LobeChatDatabase,
  id: string,
  lock = false,
): Promise<KnowledgeBaseItem> => {
  const query = db
    .select()
    .from(knowledgeBases)
    .where(
      and(
        eq(knowledgeBases.id, id),
        isNull(knowledgeBases.workspaceId),
        notTrashed(knowledgeBases.isDeleted),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw notFound();

  const enterpriseIds = await listEnterpriseKbIds(db, [id]);
  if (!enterpriseIds.includes(id)) throw notFound();

  return row;
};

/** A transfer and a content write must never commit under different owners. */
export const lockEnterpriseKb = async (
  db: LobeChatDatabase,
  kb: { id: string; userId: string },
) => {
  const current = await loadEnterpriseKb(db, kb.id, true);
  if (current.userId !== kb.userId) throw notFound();
  return current;
};
