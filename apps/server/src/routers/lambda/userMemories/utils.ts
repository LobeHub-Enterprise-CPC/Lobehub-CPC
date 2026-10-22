import { BRANDING_PROVIDER, ENABLE_BUSINESS_FEATURES } from '@lobechat/business-const';
import { type LobeChatDatabase } from '@lobechat/database';

import { FtsSearchCandidateError } from '@/database/repositories/ftsSearch';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { resolveUserMemoryEmbeddingModel } from '@/server/services/memory/userMemory/embeddingModel';

export const getEmbeddingRuntime = async (serverDB: LobeChatDatabase, userId: string) => {
  // Same model the extractor writes memory vectors with, never the file embedding model.
  const { provider, model: embeddingModel } = await resolveUserMemoryEmbeddingModel(
    serverDB,
    userId,
  );
  // Read user's provider config from database
  const agentRuntime = await initModelRuntimeFromDB(
    serverDB,
    userId,
    ENABLE_BUSINESS_FEATURES ? BRANDING_PROVIDER : provider,
  );

  return { agentRuntime, embeddingModel };
};

/** Candidate-provider outages must not be converted into successful empty memory responses. */
export const rethrowCandidateSearchError = (error: unknown) => {
  if (error instanceof FtsSearchCandidateError) throw error;
};
