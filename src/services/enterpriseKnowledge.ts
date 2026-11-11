import type { EnterpriseKbGrantInput } from '@lobechat/business-knowledge';

import { lambdaClient } from '@/libs/trpc/client';
import { observeKnowledgeAccess } from '@/services/knowledgeAccessEvents';

export type {
  EnterpriseKbAccessState,
  EnterpriseKbDirectory,
  EnterpriseKbEstimate,
  EnterpriseKbEvent,
  EnterpriseKbGrant,
  EnterpriseKbGrantInput,
} from '@lobechat/business-knowledge';

class EnterpriseKnowledgeService {
  getFileLibraries = async (id: string) =>
    (await lambdaClient.file.findById.query({ id })).knowledgeBaseIds;
  getAccess = (knowledgeBaseId: string) =>
    lambdaClient.enterpriseKnowledge.getAccess.query({ knowledgeBaseId });
  updateAccess = (knowledgeBaseId: string, version: number, grants: EnterpriseKbGrantInput[]) =>
    lambdaClient.enterpriseKnowledge.updateAccess.mutate({ knowledgeBaseId, version, grants });
  estimateAccess = (knowledgeBaseId: string, grants: EnterpriseKbGrantInput[]) =>
    lambdaClient.enterpriseKnowledge.estimateAccess.query({ knowledgeBaseId, grants });
  directory = (keyword?: string) => lambdaClient.enterpriseKnowledge.directory.query({ keyword });
  listEvents = (knowledgeBaseId: string) =>
    lambdaClient.enterpriseKnowledge.listEvents.query({ knowledgeBaseId, limit: 100 });
}

export const enterpriseKnowledgeService = observeKnowledgeAccess(new EnterpriseKnowledgeService());
