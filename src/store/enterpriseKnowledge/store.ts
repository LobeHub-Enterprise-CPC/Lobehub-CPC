import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import type { ReplicaState } from '@/libs/replica';
import { createReplicaState } from '@/libs/replica';
import type {
  EnterpriseKbAccessState,
  EnterpriseKbDirectory,
  EnterpriseKbEstimate,
  EnterpriseKbEvent,
  EnterpriseNodeLevel,
  NodeAccessEstimate,
  NodeAccessView,
} from '@/services/enterpriseKnowledge';

import { createDevtools } from '../middleware/createDevtools';

export interface EnterpriseKnowledgeState {
  accessMap: Record<string, EnterpriseKbAccessState>;
  accessReplica: ReplicaState<EnterpriseKbAccessState>;
  directoryMap: Record<string, EnterpriseKbDirectory>;
  directoryReplica: ReplicaState<EnterpriseKbDirectory>;
  estimateMap: Record<string, EnterpriseKbEstimate>;
  estimateReplica: ReplicaState<EnterpriseKbEstimate>;
  eventsMap: Record<string, EnterpriseKbEvent[]>;
  eventsReplica: ReplicaState<EnterpriseKbEvent[]>;
  fileLibrariesMap: Record<string, string[]>;
  fileLibrariesReplica: ReplicaState<string[]>;
  nodeAccessMap: Record<string, NodeAccessView>;
  nodeAccessReplica: ReplicaState<NodeAccessView>;
  nodeEstimateMap: Record<string, NodeAccessEstimate>;
  nodeEstimateReplica: ReplicaState<NodeAccessEstimate>;
  nodeLevelMap: Record<string, { level: EnterpriseNodeLevel }>;
  nodeLevelReplica: ReplicaState<{ level: EnterpriseNodeLevel }>;
}
export const initialState: EnterpriseKnowledgeState = {
  nodeAccessMap: {},
  nodeAccessReplica: createReplicaState(),
  nodeLevelMap: {},
  nodeLevelReplica: createReplicaState(),
  nodeEstimateMap: {},
  nodeEstimateReplica: createReplicaState(),
  fileLibrariesMap: {},
  fileLibrariesReplica: createReplicaState(),
  accessMap: {},
  accessReplica: createReplicaState(),
  directoryMap: {},
  directoryReplica: createReplicaState(),
  estimateMap: {},
  estimateReplica: createReplicaState(),
  eventsMap: {},
  eventsReplica: createReplicaState(),
};
export const useEnterpriseKnowledgeStore = createWithEqualityFn<EnterpriseKnowledgeState>()(
  createDevtools('enterpriseKnowledge')(() => initialState),
  shallow,
);
