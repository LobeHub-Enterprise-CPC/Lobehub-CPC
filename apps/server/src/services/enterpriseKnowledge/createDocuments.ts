import type { LobeChatDatabase } from '@/database/type';
import { DocumentService } from '@/server/services/document';

import { type EnterpriseAccessCtx, type EnterpriseScope, recordMemberUploads } from './index';

/** Content, mirror files and actual-actor attribution commit together. */
export const createEnterpriseDocuments = async (
  ctx: EnterpriseAccessCtx,
  scope: EnterpriseScope,
  inputs: Parameters<DocumentService['createDocument']>[0][],
) =>
  ctx.serverDB.transaction(async (tx) => {
    const db = tx as unknown as LobeChatDatabase;
    const service = new DocumentService(db, scope.ownerId);
    const created = [];
    for (const input of inputs)
      created.push(
        await service.createDocument({ ...input, knowledgeBaseId: scope.knowledgeBaseId }),
      );
    await recordMemberUploads(
      { ...ctx, serverDB: db },
      scope.knowledgeBaseId,
      created.flatMap((doc) => [doc.id, ...(doc.fileId ? [doc.fileId] : [])]),
    );
    return created;
  });
