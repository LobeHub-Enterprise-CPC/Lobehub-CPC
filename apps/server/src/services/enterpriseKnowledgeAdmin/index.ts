import type { EnterpriseKbGrantInput } from '@lobechat/business-knowledge';
import {
  estimateEnterpriseKbAccess,
  getEnterpriseKbAccessState,
  getEnterpriseKbDirectory,
  listEnterpriseKbEvents,
  searchEnterpriseKbMembers,
  updateEnterpriseKbAccess,
} from '@lobechat/business-knowledge';

import type { LobeChatDatabase } from '@/database/type';

import { EnterpriseKbContentService } from './content';
import { EnterpriseKbLibraryService } from './libraries';
import { EnterpriseKbNodeAccessService } from './nodeAccess';
import { type AdminActor, loadEnterpriseKb, toEnterpriseActor } from './shared';

export class EnterpriseKnowledgeAdminService {
  readonly libraries: EnterpriseKbLibraryService;
  readonly content: EnterpriseKbContentService;
  readonly nodeAccess: EnterpriseKbNodeAccessService;

  constructor(private readonly db: LobeChatDatabase) {
    this.libraries = new EnterpriseKbLibraryService(db);
    this.content = new EnterpriseKbContentService(db);
    this.nodeAccess = new EnterpriseKbNodeAccessService(db);
  }

  members = async (params: { keyword: string; limit?: number }) => ({
    items: await searchEnterpriseKbMembers(this.db, params),
  });
  directory = (params: { keyword?: string }) => getEnterpriseKbDirectory(this.db, params);
  getAccess = async (id: string) => {
    await loadEnterpriseKb(this.db, id);
    return getEnterpriseKbAccessState(this.db, id);
  };
  updateAccess = async (
    id: string,
    params: { actor: AdminActor; grants: EnterpriseKbGrantInput[]; version: number },
  ) => {
    await loadEnterpriseKb(this.db, id);
    return this.db.transaction((tx) =>
      updateEnterpriseKbAccess(tx, {
        ...params,
        actor: toEnterpriseActor(params.actor),
        knowledgeBaseId: id,
      }),
    );
  };
  estimateAccess = async (id: string, grants: EnterpriseKbGrantInput[]) => {
    await loadEnterpriseKb(this.db, id);
    return estimateEnterpriseKbAccess(this.db, { grants, knowledgeBaseId: id });
  };
  events = async (id: string, limit: number) => {
    await loadEnterpriseKb(this.db, id);
    return { items: await listEnterpriseKbEvents(this.db, { knowledgeBaseId: id, limit }) };
  };
}
