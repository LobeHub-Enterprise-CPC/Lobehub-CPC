import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import type { ReplicaState } from '@/libs/replica';
import { createReplicaState } from '@/libs/replica';
import type {
  EnterpriseKbAccessState,
  EnterpriseKbDirectory,
  EnterpriseKbEstimate,
  EnterpriseKbEvent,
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
}
export const initialState: EnterpriseKnowledgeState = {
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
