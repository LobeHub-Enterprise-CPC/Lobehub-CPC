import type { EstimateParams } from './projection';
import { estimateKey } from './projection';
import type { EnterpriseKnowledgeState } from './store';

export const enterpriseKnowledgeSelectors = {
  fileLibraries: (id?: string) => (s: EnterpriseKnowledgeState) =>
    id ? s.fileLibrariesMap[id] : undefined,
  access: (id: string) => (s: EnterpriseKnowledgeState) => s.accessMap[id],
  directory: (keyword: string) => (s: EnterpriseKnowledgeState) => s.directoryMap[keyword],
  estimate: (params: EstimateParams | null) => (s: EnterpriseKnowledgeState) =>
    params ? s.estimateMap[estimateKey(params)] : undefined,
  events: (id: string) => (s: EnterpriseKnowledgeState) => s.eventsMap[id],
};
