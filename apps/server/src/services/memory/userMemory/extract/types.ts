import type { ModelRuntime } from '@lobechat/model-runtime';

import type { ListTopicsForMemoryExtractorCursor } from '@/database/models/topic';
import type { ListUsersForMemoryExtractorCursor } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import type { getServerGlobalConfig } from '@/server/globalConfig';
import type {
  MemoryAgentConfig,
  parseMemoryExtractionConfig,
} from '@/server/globalConfig/parseMemoryExtractionConfig';
import type { LayersEnum, MemorySourceType } from '@/types/userMemory';

/**
 * A layer's memories, validated and embedded, not yet written. `write` only touches the database,
 * so all layers of a segment and its watermark can be written in one transaction.
 */
export interface PreparedLayer {
  /** Writes the memories through `db`; resolves with the created memory ids. */
  write: (db: LobeChatDatabase) => Promise<string[]>;
}

export type RuntimeBundle = {
  embeddings: ModelRuntime;
  gatekeeper: ModelRuntime;
  layerExtractor: ModelRuntime;
};

export interface MemoryExtractionModelConfig {
  embeddingsModel: string;
  gateModel: string;
  layerModels: Partial<Record<LayersEnum, string>>;
  observabilityS3: MemoryExtractionConfig['observabilityS3'];
}

export interface ResolvedMemoryServiceConfig {
  agents: {
    embedding: MemoryAgentConfig;
    gatekeeper: MemoryAgentConfig;
    layerExtractor: MemoryAgentConfig;
  };
  embeddingContextLimit?: number;
  extractorContextLimit?: number;
  modelConfig: MemoryExtractionModelConfig;
  overrides: {
    embedding: {
      model: boolean;
      provider: boolean;
    };
    gatekeeper: {
      model: boolean;
      provider: boolean;
    };
    layerExtractor: {
      model: boolean;
      provider: boolean;
    };
  };
}

export interface TopicExtractionJob {
  asyncTaskId?: string;
  forceAll: boolean;
  forceTopics: boolean;
  from?: Date;
  layers: LayersEnum[];
  reportProgress?: boolean;
  /**
   * Watermark this run already reached on the topic, for its next segment. Without it the
   * topic's stored watermark applies, or none when the run forces a full re-extraction.
   */
  resumeFrom?: string;
  source: MemorySourceType;
  to?: Date;
  topicId: string;
  userId: string;
  userInitiated?: boolean;
  workspaceId?: string;
}

export interface TopicPaginationJob {
  cursor?: ListTopicsForMemoryExtractorCursor;
  forceAll: boolean;
  forceTopics: boolean;
  from?: Date;
  to?: Date;
  userId: string;
  /** A user asked for this run, so topics that failed before are retried. */
  userInitiated?: boolean;
  workspaceId?: string;
}

export interface UserPaginationResult {
  cursor?: ListUsersForMemoryExtractorCursor;
  ids: string[];
}

export type MemoryExtractionConfig = ReturnType<typeof parseMemoryExtractionConfig>;

export type ServerConfig = Awaited<ReturnType<typeof getServerGlobalConfig>>;
