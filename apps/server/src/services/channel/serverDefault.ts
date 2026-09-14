import {
  type ChannelRuntime,
  type HeterogeneousProviderConfig,
  RequestTrigger,
} from '@lobechat/types';

import { AgentOperationModel } from '@/database/models/agentOperation';
import type { LobeChatDatabase } from '@/database/type';
import { signHeteroOperationJWT } from '@/libs/trpc/utils/internalJwt';
import {
  getServerDefaultHeterogeneousModels,
  initModelRuntimeFromServerConfig,
  resolveServerDefaultHeterogeneousModel,
  SERVER_DEFAULT_HETEROGENEOUS_AGENT_TYPES,
} from '@/server/modules/ModelRuntime';

export interface ChannelServerDefaultBinding {
  model: string;
  token: string;
}

const assertCapability = async (runtime: ChannelRuntime) => {
  if (process.env.ENABLE_SERVER_DEFAULT_HETEROGENEOUS_AGENT === '0')
    throw new Error('Server-default agents are disabled');
  const models = await getServerDefaultHeterogeneousModels().catch(() => undefined);
  if (
    !models ||
    !SERVER_DEFAULT_HETEROGENEOUS_AGENT_TYPES.includes(runtime as never) ||
    !models[runtime as keyof typeof models]?.length
  )
    throw new Error('No server model is available for this heterogeneous agent');
};

/** Create a credential-free, run-scoped model binding for a Channel device process. */
export async function beginChannelServerDefaultOperation(params: {
  agentId: string;
  db: LobeChatDatabase;
  ownerId: string;
  provider: HeterogeneousProviderConfig;
  runId: string;
  runtime: ChannelRuntime;
}): Promise<ChannelServerDefaultBinding | undefined> {
  const { provider } = params;
  if (provider.authMode !== 'api' || provider.apiConfig?.source !== 'server-default') return;

  await assertCapability(params.runtime);
  const selection = await resolveServerDefaultHeterogeneousModel(
    params.runtime as never,
    provider.apiConfig.model,
  ).catch(() => {
    throw new Error('The selected server model is not available for this heterogeneous agent');
  });
  await initModelRuntimeFromServerConfig({
    actorUserId: params.ownerId,
    workspaceId: undefined,
  }).catch(() => {
    throw new Error('The selected server model runtime is unavailable');
  });

  const operationModel = new AgentOperationModel(params.db, params.ownerId);
  await operationModel.recordStart({
    agentId: params.agentId,
    metadata: {
      agentType: params.runtime,
      channelServerDefault: true,
      serverDefaultHeterogeneous: true,
    },
    model: selection.model,
    operationId: params.runId,
    provider: selection.provider,
    trigger: RequestTrigger.Chat,
  });
  const operation = await operationModel.findById(params.runId);
  if (
    !operation ||
    operation.userId !== params.ownerId ||
    operation.workspaceId !== null ||
    operation.status !== 'running' ||
    operation.topicId !== null ||
    operation.agentId !== params.agentId ||
    operation.model !== selection.model ||
    operation.provider !== selection.provider ||
    operation.metadata?.agentType !== params.runtime ||
    operation.metadata?.channelServerDefault !== true
  )
    throw new Error('Operation id is already in use');

  return {
    model: 'lobehub-default',
    token: await signHeteroOperationJWT({
      capabilities: ['model:invoke'],
      model: selection.model,
      operationId: params.runId,
      providerId: selection.provider,
      userId: params.ownerId,
      workspaceId: undefined,
    }),
  };
}

/** Settle only Channel-owned server-default bookkeeping; unrelated operations are untouched. */
export async function settleChannelServerDefaultOperation(params: {
  db: LobeChatDatabase;
  ownerId: string;
  runId: string;
  status: 'done' | 'error' | 'interrupted';
}) {
  const model = new AgentOperationModel(params.db, params.ownerId);
  const operation = await model.findById(params.runId);
  if (
    !operation ||
    operation.userId !== params.ownerId ||
    operation.workspaceId !== null ||
    operation.metadata?.channelServerDefault !== true ||
    operation.topicId !== null
  )
    return;
  // Reconciliation may observe a normal completion after an explicit stop (or vice versa).
  // A terminal Channel operation is already safely settled and must not block writer release.
  if (operation.status !== 'running') return;
  if (!(await model.settleRunning(params.runId, params.status))) {
    const current = await model.findById(params.runId);
    if (
      !current ||
      current.userId !== params.ownerId ||
      current.workspaceId !== null ||
      current.metadata?.channelServerDefault !== true ||
      current.topicId !== null ||
      current.status === 'running'
    )
      throw new Error('Operation settlement was not confirmed');
  }
}
