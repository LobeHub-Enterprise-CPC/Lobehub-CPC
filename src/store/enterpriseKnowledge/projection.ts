import { defineReplica } from '@/libs/replica';
import type {
  EnterpriseKbAccessState,
  EnterpriseKbDirectory,
  EnterpriseKbEstimate,
  EnterpriseKbEvent,
  EnterpriseKbGrantInput,
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
