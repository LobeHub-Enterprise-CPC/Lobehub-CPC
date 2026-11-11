import { defineReplica } from '@/libs/replica';
import type {
  EnterpriseKbAccessState,
  EnterpriseKbDirectory,
  EnterpriseKbEstimate,
  EnterpriseKbEvent,
  EnterpriseKbGrantInput,
  EnterpriseNodeLevel,
  NodeAccessEstimate,
  NodeAccessParams,
  NodeAccessView,
  NodeEstimateParams,
  NodeLevelParams,
} from '@/services/enterpriseKnowledge';

export interface EstimateParams {
  grants: EnterpriseKbGrantInput[];
  knowledgeBaseId: string;
}
export const estimateKey = ({ knowledgeBaseId, grants }: EstimateParams) =>
  `${knowledgeBaseId}:${JSON.stringify(grants)}`;
export const accessResource = defineReplica<string, EnterpriseKbAccessState>({
  key: (id) => id,
  name: 'enterpriseKbAccess',
  storage: 'memory',
  version: 1,
});
export const eventsResource = defineReplica<string, EnterpriseKbEvent[]>({
  key: (id) => id,
  name: 'enterpriseKbEvents',
  storage: 'memory',
  version: 1,
});
export const directoryResource = defineReplica<string, EnterpriseKbDirectory>({
  key: (keyword) => keyword,
  name: 'enterpriseKbDirectory',
  storage: 'memory',
  version: 1,
});
export const estimateResource = defineReplica<EstimateParams, EnterpriseKbEstimate>({
  key: estimateKey,
  name: 'enterpriseKbEstimate',
  storage: 'memory',
  version: 1,
});

export const fileLibrariesResource = defineReplica<string, string[]>({
  key: (id) => id,
  name: 'enterpriseKbFileLibraries',
  storage: 'memory',
  version: 1,
});

export const nodeKey = ({ knowledgeBaseId, nodeId }: NodeLevelParams) =>
  JSON.stringify([knowledgeBaseId, nodeId || null]);
export const nodeEstimateKey = (params: NodeEstimateParams) => JSON.stringify(params);
export const nodeAccessResource = defineReplica<NodeAccessParams, NodeAccessView>({
  key: nodeKey,
  name: 'enterpriseKbNodeAccess',
  storage: 'memory',
  version: 1,
});
export const nodeLevelResource = defineReplica<NodeLevelParams, { level: EnterpriseNodeLevel }>({
  key: nodeKey,
  name: 'enterpriseKbNodeLevel',
  storage: 'memory',
  version: 1,
});
export const nodeEstimateResource = defineReplica<NodeEstimateParams, NodeAccessEstimate>({
  key: nodeEstimateKey,
  name: 'enterpriseKbNodeEstimate',
  storage: 'memory',
  version: 1,
});
