import { cacheScope, createReplicaSlice, recordLens } from '@/libs/replica';
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
import { enterpriseKnowledgeService } from '@/services/enterpriseKnowledge';
import { useKnowledgeBaseStore } from '@/store/library';
import { isTrpcErrorCode } from '@/utils/trpcError';

import type { EstimateParams } from './projection';
import {
  accessResource,
  directoryResource,
  estimateResource,
  eventsResource,
  fileLibrariesResource,
  nodeAccessResource,
  nodeEstimateResource,
  nodeLevelResource,
} from './projection';
import type { EnterpriseKnowledgeState } from './store';
import { initialState, useEnterpriseKnowledgeStore } from './store';

export class EnterpriseKnowledgeActionImpl {
  readonly #nodeAccess;
  readonly #nodeLevel;
  readonly #nodeEstimate;
  readonly #access;
  readonly #fileLibraries;
  readonly #directory;
  readonly #events;
  readonly #estimate;
  constructor() {
    const get = useEnterpriseKnowledgeStore.getState;
    const set = useEnterpriseKnowledgeStore.setState;
    this.#nodeAccess = createReplicaSlice(nodeAccessResource, {
      actionPrefix: 'enterpriseKbNodeAccess',
      get,
      set,
      fetcher: enterpriseKnowledgeService.getNodeAccess,
      effects: {
        onError: (error, _id, { key, scope }) => {
          if (key && isTrpcErrorCode(error, 'NOT_FOUND')) void this.#nodeAccess.remove(key, scope);
        },
      },
      stateKey: 'nodeAccessReplica',
      view: recordLens<EnterpriseKnowledgeState, NodeAccessView>('nodeAccessMap'),
    });
    this.#nodeLevel = createReplicaSlice(nodeLevelResource, {
      actionPrefix: 'enterpriseKbNodeLevel',
      get,
      set,
      fetcher: enterpriseKnowledgeService.resolveLevel,
      effects: {
        onError: (_error, _id, { key, scope }) => {
          if (key) void this.#nodeLevel.remove(key, scope);
        },
      },
      stateKey: 'nodeLevelReplica',
      view: recordLens<EnterpriseKnowledgeState, { level: EnterpriseNodeLevel }>('nodeLevelMap'),
    });
    this.#nodeEstimate = createReplicaSlice(nodeEstimateResource, {
      actionPrefix: 'enterpriseKbNodeEstimate',
      get,
      set,
      fetcher: enterpriseKnowledgeService.estimateNodeAccess,
      stateKey: 'nodeEstimateReplica',
      view: recordLens<EnterpriseKnowledgeState, NodeAccessEstimate>('nodeEstimateMap'),
    });
    this.#fileLibraries = createReplicaSlice(fileLibrariesResource, {
      actionPrefix: 'enterpriseKbFileLibraries',
      get,
      set,
      fetcher: enterpriseKnowledgeService.getFileLibraries,
      stateKey: 'fileLibrariesReplica',
      view: recordLens<EnterpriseKnowledgeState, string[]>('fileLibrariesMap'),
    });
    this.#access = createReplicaSlice(accessResource, {
      actionPrefix: 'enterpriseKbAccess',
      get,
      set,
      fetcher: enterpriseKnowledgeService.getAccess,
      effects: {
        onError: (error, _id, { key, scope }) => {
          if (key !== undefined && isTrpcErrorCode(error, 'NOT_FOUND'))
            void this.#access.remove(key, scope);
        },
      },
      stateKey: 'accessReplica',
      view: recordLens<EnterpriseKnowledgeState, EnterpriseKbAccessState>('accessMap'),
    });
    this.#directory = createReplicaSlice(directoryResource, {
      actionPrefix: 'enterpriseKbDirectory',
      get,
      set,
      fetcher: enterpriseKnowledgeService.directory,
      stateKey: 'directoryReplica',
      view: recordLens<EnterpriseKnowledgeState, EnterpriseKbDirectory>('directoryMap'),
    });
    this.#events = createReplicaSlice(eventsResource, {
      actionPrefix: 'enterpriseKbEvents',
      get,
      set,
      fetcher: enterpriseKnowledgeService.listEvents,
      effects: {
        onError: (error, _id, { key, scope }) => {
          if (key !== undefined && isTrpcErrorCode(error, 'NOT_FOUND'))
            void this.#events.remove(key, scope);
        },
      },
      stateKey: 'eventsReplica',
      view: recordLens<EnterpriseKnowledgeState, EnterpriseKbEvent[]>('eventsMap'),
    });
    this.#estimate = createReplicaSlice(estimateResource, {
      actionPrefix: 'enterpriseKbEstimate',
      get,
      set,
      fetcher: ({ knowledgeBaseId, grants }) =>
        enterpriseKnowledgeService.estimateAccess(knowledgeBaseId, grants),
      stateKey: 'estimateReplica',
      view: recordLens<EnterpriseKnowledgeState, EnterpriseKbEstimate>('estimateMap'),
    });
  }
  useFetchNodeAccess = (params: NodeAccessParams | null) => this.#nodeAccess.useSync(params);
  useFetchNodeLevel = (params: NodeLevelParams | null) => this.#nodeLevel.useSync(params);
  useFetchNodeEstimate = (params: NodeEstimateParams | null) => this.#nodeEstimate.useSync(params);
  updateNodeAccess = async (params: NodeEstimateParams & { version: number }) => {
    const scope = cacheScope.get();
    try {
      const saved = await enterpriseKnowledgeService.updateNodeAccess(params);
      this.#nodeAccess.replace(params, saved, scope);
    } catch (error) {
      if (isTrpcErrorCode(error, 'CONFLICT'))
        await this.#nodeAccess.fetch(params, { fresh: true, scope });
      throw error;
    }
    await Promise.allSettled([
      this.#nodeLevel.revalidate(),
      this.#nodeEstimate.revalidate(),
      this.#events.revalidate(params.knowledgeBaseId),
    ]);
  };
  useFetchFileLibraries = (id: string | null) => this.#fileLibraries.useSync(id);
  useFetchAccess = (id: string | null) => this.#access.useSync(id);
  useFetchDirectory = (keyword: string | null) => this.#directory.useSync(keyword);
  useFetchEvents = (id: string | null) => this.#events.useSync(id);
  useFetchEstimate = (params: EstimateParams | null) => this.#estimate.useSync(params);
  refreshAccess = (id: string) => this.#access.fetch(id, { fresh: true });
  updateAccess = async (id: string, version: number, grants: EnterpriseKbGrantInput[]) => {
    const scope = cacheScope.get();
    try {
      await enterpriseKnowledgeService.updateAccess(id, version, grants);
    } catch (error) {
      if (isTrpcErrorCode(error, 'CONFLICT')) await this.#access.fetch(id, { fresh: true, scope });
      throw error;
    }
    await this.#access.fetch(id, { fresh: true, scope });
    await Promise.all([
      this.#events.revalidate(id),
      useKnowledgeBaseStore.getState().refreshKnowledgeBaseList(),
    ]);
  };
  reset = () => {
    this.#nodeAccess.clear();
    this.#nodeLevel.clear();
    this.#nodeEstimate.clear();
    this.#fileLibraries.clear();
    this.#access.clear();
    this.#directory.clear();
    this.#events.clear();
    this.#estimate.clear();
    useEnterpriseKnowledgeStore.setState(initialState, false, 'enterpriseKnowledge/reset');
  };
}
export const enterpriseKnowledgeActions = new EnterpriseKnowledgeActionImpl();
