import type { SandboxStorageClaim } from '@lobechat/builtin-tool-cloud-sandbox';

import { resolveMarketServiceIdentity } from '@/libs/trusted-client/resolveIdentity';
import { MarketService } from '@/server/services/market';

import type { ToolExecutionContext } from '../types';

/** The runtime context supplies identity; tool arguments cannot select another operation. */
export const createSandboxMarketService = async (
  context: ToolExecutionContext,
  accessToken: string | undefined,
  workspaceId: string | undefined,
  sandboxStorage: SandboxStorageClaim | null | undefined,
) => {
  if (!context.userId) throw new Error('userId is required for sandbox execution');
  const identity = await resolveMarketServiceIdentity({
    proxyExecution: Boolean(context.agentShareVisitor),
    sandboxStorage,
    serverDB: context.serverDB,
    userId: context.userId,
    workspaceId,
  });
  return new MarketService({
    accessToken,
    userInfo: {
      ...identity,
      sandboxOperation:
        context.operationId && context.topicId
          ? { operationId: context.operationId, topicId: context.topicId }
          : undefined,
    },
  });
};
