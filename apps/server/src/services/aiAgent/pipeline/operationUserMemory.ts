import type { LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';

import { UserPersonaModel } from '@/database/models/userMemory/persona';
import type { ServerUserMemoryConfig } from '@/server/modules/Mecha/ContextEngineering/types';

const log = debug('lobe-server:ai-agent-service');

/** Resolve the same persona snapshot for ordinary and Channel Native runs. */
export async function resolveOperationUserMemory(
  deps: { db: LobeChatDatabase; userId: string },
  globalMemoryEnabled: boolean,
): Promise<ServerUserMemoryConfig | undefined> {
  let userMemory: ServerUserMemoryConfig | undefined;

  if (globalMemoryEnabled) {
    try {
      const personaModel = new UserPersonaModel(deps.db, deps.userId);
      const persona = await personaModel.getLatestPersonaDocument();

      if (persona?.persona) {
        userMemory = {
          fetchedAt: Date.now(),
          memories: {
            contexts: [],
            experiences: [],
            persona: {
              narrative: persona.persona,
              tagline: persona.tagline,
            },
            preferences: [],
          },
        };
        log('execAgent: fetched user persona (version: %d)', persona.version);
      }
    } catch (error) {
      log('execAgent: failed to fetch user persona: %O', error);
    }
  }

  return userMemory;
}
