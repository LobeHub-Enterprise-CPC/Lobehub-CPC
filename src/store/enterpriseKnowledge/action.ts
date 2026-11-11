import { cacheScope, createReplicaSlice, recordLens } from '@/libs/replica';
import type {
  EnterpriseKbAccessState,
  EnterpriseKbDirectory,
  EnterpriseKbEstimate,
  EnterpriseKbEvent,
  EnterpriseKbGrantInput,
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
} from './projection';
import type { EnterpriseKnowledgeState } from './store';
import { initialState, useEnterpriseKnowledgeStore } from './store';

export class EnterpriseKnowledgeActionImpl {
  readonly #access;
  readonly #fileLibraries;
  readonly #directory;
  readonly #events;
  readonly #estimate;
  constructor() {
    const get = useEnterpriseKnowledgeStore.getState;
    const set = useEnterpriseKnowledgeStore.setState;
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
    this.#fileLibraries.clear();
    this.#access.clear();
    this.#directory.clear();
    this.#events.clear();
    this.#estimate.clear();
    useEnterpriseKnowledgeStore.setState(initialState, false, 'enterpriseKnowledge/reset');
  };
}
export const enterpriseKnowledgeActions = new EnterpriseKnowledgeActionImpl();
