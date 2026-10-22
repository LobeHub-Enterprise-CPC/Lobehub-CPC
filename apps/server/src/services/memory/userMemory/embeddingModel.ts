import { DEFAULT_USER_MEMORY_EMBEDDING_MODEL_ITEM } from '@lobechat/const';
import type { LobeChatDatabase } from '@lobechat/database';
import type { UserServiceModelConfig } from '@lobechat/types';
import { eq } from 'drizzle-orm';

import { userSettings } from '@/database/schemas';
import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';

import { resolveMemoryServiceModelConfig, resolveUserMemoryAgent } from './systemAgent';

export interface UserMemoryEmbeddingModel {
  model: string;
  provider: string;
}

/**
 * The embedding model for a user's memory vectors: the user's `userMemoryEmbedding`
 * over the tenant/deployment layer, falling back to the extraction config exactly
 * as the extractor does. Every call site that writes memory vectors or embeds a
 * query to compare against them must use this, never the file embedding model.
 */
export const resolveUserMemoryEmbeddingModel = async (
  serverDB: LobeChatDatabase,
  userId: string,
): Promise<UserMemoryEmbeddingModel> => {
  const row = await serverDB.query.userSettings.findFirst({
    columns: { systemAgent: true },
    where: eq(userSettings.id, userId),
  });
  const systemAgent = await resolveMemoryServiceModelConfig(
    row?.systemAgent as Partial<UserServiceModelConfig> | undefined,
  );
  const { model, provider } = resolveUserMemoryAgent(
    systemAgent,
    'userMemoryEmbedding',
    parseMemoryExtractionConfig().embedding,
  );

  return { model, provider: provider || DEFAULT_USER_MEMORY_EMBEDDING_MODEL_ITEM.provider };
};
