import type {
  EnterpriseKbEstimate,
  EnterpriseKbGrant,
  EnterpriseKbGrantInput,
} from '@lobechat/business-knowledge';

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

export interface NodeAccessParams {
  knowledgeBaseId: string;
  nodeId: string;
}
export interface NodeLevelParams {
  knowledgeBaseId: string;
  nodeId?: string | null;
}
export type EnterpriseNodeLevel = 'owner' | 'edit' | 'view' | 'path';
export interface NodeAccessView {
  grants: EnterpriseKbGrant[];
  inheritedFrom: { id: string | null; name: string };
  inheritedFromNodeId: string | null;
  mode: 'custom' | 'inherit';
  node: { id: string; kind: 'document' | 'file' | 'folder'; name: string };
  version: number;
}
export interface NodeEstimateParams extends NodeAccessParams {
  grants: EnterpriseKbGrantInput[];
  mode: 'custom' | 'inherit';
}
export interface NodeAccessEstimate extends EnterpriseKbEstimate {
  pathOnly?: { principalId: string; principalType: 'department' | 'user' }[];
}
class EnterpriseKnowledgeService {
  resolveLevel = (params: NodeLevelParams): Promise<{ level: EnterpriseNodeLevel }> =>
    lambdaClient.enterpriseKnowledge.resolveLevel.query(params);
  getNodeAccess = (params: NodeAccessParams): Promise<NodeAccessView> =>
    lambdaClient.enterpriseKnowledge.getNodeAccess.query(params);
  updateNodeAccess = (params: NodeEstimateParams & { version: number }): Promise<NodeAccessView> =>
    lambdaClient.enterpriseKnowledge.updateNodeAccess.mutate(params);
  estimateNodeAccess = (params: NodeEstimateParams): Promise<NodeAccessEstimate> =>
    lambdaClient.enterpriseKnowledge.estimateNodeAccess.query(params);
  canEditNodes = async (knowledgeBaseId: string, nodeIds: (string | null)[]) => {
    const levels = await Promise.all(
      [...new Set(nodeIds)].map((nodeId) => this.resolveLevel({ knowledgeBaseId, nodeId })),
    );
    return levels.every(({ level }) => level === 'owner' || level === 'edit');
  };
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
