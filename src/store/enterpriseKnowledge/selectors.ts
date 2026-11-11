import type {
  NodeAccessParams,
  NodeEstimateParams,
  NodeLevelParams,
} from '@/services/enterpriseKnowledge';

import type { EstimateParams } from './projection';
import { estimateKey, nodeEstimateKey, nodeKey } from './projection';
import type { EnterpriseKnowledgeState } from './store';

export const enterpriseKnowledgeSelectors = {
  nodeAccess: (params: NodeAccessParams | null) => (s: EnterpriseKnowledgeState) =>
    params ? s.nodeAccessMap[nodeKey(params)] : undefined,
  nodeLevel: (params: NodeLevelParams | null) => (s: EnterpriseKnowledgeState) =>
    params ? s.nodeLevelMap[nodeKey(params)] : undefined,
  nodeEstimate: (params: NodeEstimateParams | null) => (s: EnterpriseKnowledgeState) =>
    params ? s.nodeEstimateMap[nodeEstimateKey(params)] : undefined,
  fileLibraries: (id?: string) => (s: EnterpriseKnowledgeState) =>
    id ? s.fileLibrariesMap[id] : undefined,
  access: (id: string) => (s: EnterpriseKnowledgeState) => s.accessMap[id],
  directory: (keyword: string) => (s: EnterpriseKnowledgeState) => s.directoryMap[keyword],
  estimate: (params: EstimateParams | null) => (s: EnterpriseKnowledgeState) =>
    params ? s.estimateMap[estimateKey(params)] : undefined,
  events: (id: string) => (s: EnterpriseKnowledgeState) => s.eventsMap[id],
};
