import { DEFAULT_TOOL_APPROVAL_MODE } from '@lobechat/business-const';
import { getModelPropertyWithFallback } from '@lobechat/model-runtime';
import type {
  ChannelMemberConfig,
  ChatToolPayload,
  StepActivatedSkill,
  UserToolConfig,
} from '@lobechat/types';

import { AiModelModel } from '@/database/models/aiModel';
import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import { MessageModel } from '@/database/models/message';
import { PluginModel } from '@/database/models/plugin';
import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';
import { isDeviceCapablePlan, isLocalSandboxEnabled } from '@/helpers/executionTarget';
import { resolveRunActiveDeviceId } from '@/server/modules/AgentRuntime/executors/resolveRunActiveDeviceId';
import { resolveToolTimeoutMs } from '@/server/modules/AgentRuntime/resolveToolTimeout';
import { AgentService } from '@/server/services/agent';
import { AgentDocumentsService } from '@/server/services/agentDocuments';
import { resolveDeviceAccessPolicy } from '@/server/services/aiAgent/deviceAccessPolicy';
import { prepareOperationSkills } from '@/server/services/aiAgent/pipeline/operationSkills';
import { resolveOperationUserMemory } from '@/server/services/aiAgent/pipeline/operationUserMemory';
import { resolveRunAgentConfig } from '@/server/services/aiAgent/pipeline/resolveRunAgentConfig';
import { discoverTools } from '@/server/services/aiAgent/pipeline/toolDiscovery';
import { ComposioService } from '@/server/services/composio';
import { MarketService } from '@/server/services/market';
import { mcpService } from '@/server/services/mcp';
import { ToolExecutionService } from '@/server/services/toolExecution';
import { BuiltinToolsExecutor } from '@/server/services/toolExecution/builtin';

import { createChannelAgentContextBuilder } from './agentContext';
import type { ChannelNativeCapabilities } from './host';

/** Channel supplies conversation IO; agent configuration and tool policy belong to ordinary chat. */
export async function loadChannelNativeCapabilities(
  db: LobeChatDatabase,
  ownerId: string,
  config: ChannelMemberConfig,
): Promise<ChannelNativeCapabilities> {
  if (!config.agentId) throw new Error('Native Channel members must reference an existing Agent');
  const { agentConfig, agentSlug, disabledPluginIds, resolvedAgentId } =
    await resolveRunAgentConfig(
      {
        db,
        userId: ownerId,
        resolveAgentConfigOrThrow: async (id) => {
          const agent = await new AgentService(db, ownerId).getAgentConfig(id);
          if (!agent) throw new Error('Native agent is no longer accessible');
          return agent;
        },
      },
      { identifier: config.agentId, throwIfExecutionAborted: async () => {} },
    );
  if (agentConfig.agencyConfig?.heterogeneousProvider)
    throw new Error('Channel Agent runtime has changed');

  // The membership snapshot is display data, not an override of the current Agent.
  const { model, provider } = agentConfig;
  if (!model || !provider) throw new Error('Configure a model in this Agent before activating it');
  const configuredModel = await new AiModelModel(db, ownerId).findByIdAndProvider(model, provider);
  const contextWindowTokens =
    configuredModel?.contextWindowTokens ||
    (await getModelPropertyWithFallback<number | undefined>(
      model,
      'contextWindowTokens',
      provider,
    ));
  if (!contextWindowTokens)
    throw new Error('Configure the Native model context-window size before activating this member');

  const settings = await new UserModel(db, ownerId).getUserSettings();
  const memorySettings = settings?.memory as { enabled?: boolean } | undefined;
  const marketSettings = settings?.market as { accessToken?: string } | undefined;
  const generalSettings = settings?.general as { timezone?: string } | undefined;
  const intervention = (settings?.tool as UserToolConfig | undefined)?.humanIntervention;
  // Match ordinary chat: use the distribution default and normalize legacy headless settings.
  const approvalMode = intervention?.approvalMode;
  const globalMemoryEnabled =
    agentConfig.chatConfig?.memory?.enabled ?? memorySettings?.enabled !== false;
  const deviceAccessPolicy = resolveDeviceAccessPolicy({});
  const agentDocumentsService = new AgentDocumentsService(db, ownerId);
  const discovery = await discoverTools(
    {
      agentDocumentsService,
      composioService: new ComposioService({ db, userId: ownerId }),
      connectorModel: new ConnectorModel(db, ownerId),
      connectorToolModel: new ConnectorToolModel(db, ownerId),
      db,
      getMarketService: async () =>
        new MarketService({
          accessToken: marketSettings?.accessToken,
          userInfo: { userId: ownerId },
        }),
      messageModel: new MessageModel(db, ownerId),
      pluginModel: new PluginModel(db, ownerId),
      userId: ownerId,
    },
    {
      agentConfig,
      canUseDevice: deviceAccessPolicy.canUseDevice,
      model,
      prompt: '',
      provider,
      resolvedAgentId,
    },
    {
      agentSlug,
      disabledPluginIds,
      globalMemoryEnabled,
      hasMentionedAgents: false,
      isFixedDeviceTarget: false,
      loadHistoryMessages: async () => [],
      requestedDeviceId: config.deviceId,
      throwIfExecutionAborted: async () => {},
    },
  );
  const operationSkillSet = await prepareOperationSkills(
    { agentDocumentsService, db, userId: ownerId },
    {
      agentConfig,
      agentPlugins: discovery.agentPlugins,
      disabledPluginIds,
      executionPlan: discovery.executionPlan,
      resolvedAgentId,
    },
  );
  const service = new ToolExecutionService({
    mcpService,
    builtinToolsExecutor: new BuiltinToolsExecutor(db, ownerId),
  });
  return {
    contextWindowTokens,
    compressionEnabled: agentConfig.chatConfig?.enableContextCompression ?? true,
    modelParameters: { ...agentConfig.params },
    modelRuntimeConfig: { model, provider },
    userInterventionConfig: {
      approvalMode:
        approvalMode === 'headless' ? 'auto-run' : approvalMode || DEFAULT_TOOL_APPROVAL_MODE,
      allowList: intervention?.allowList || [],
    },
    systemRole: agentConfig.systemRole,
    enabledToolIds: discovery.toolsResult.enabledToolIds,
    tools: discovery.tools || [],
    toolManifestMap: discovery.toolManifestMap,
    toolSourceMap: discovery.toolSourceMap,
    toolExecutorMap: discovery.toolExecutorMap,
    runtimeMetadata: {
      agentConfig,
      activeDeviceId: discovery.activeDeviceId,
      activeDeviceScope: discovery.activeDeviceScope,
      deviceAccessPolicy,
      deviceSystemInfo: { workingDirectory: config.workingDirectory },
      executionPlan: discovery.executionPlan,
      operationSkillSet,
      userMemory: await resolveOperationUserMemory({ db, userId: ownerId }, globalMemoryEnabled),
    },
    context: createChannelAgentContextBuilder({
      agentConfig,
      contextWindowTokens,
      searchDecision: discovery.searchDecision,
      serverDB: db,
      userId: ownerId,
      userTimezone: generalSettings?.timezone,
    }),
    toolTransport: {
      maxRetries: 0,
      run: async (call, context) => {
        context.abortSignal?.throwIfAborted();
        const manifest = context.effectiveManifestMap[call.identifier];
        if (!manifest?.api.some((api: { name: string }) => api.name === call.apiName))
          throw new Error('Tool is not authorized for this Channel member');
        const metadata = context.state.metadata;
        const plan = metadata?.executionPlan;
        return {
          attempts: 1,
          result: await service.executeTool(
            { ...call, source: call.source ?? (context.toolSource as ChatToolPayload['source']) },
            {
              serverDB: db,
              userId: ownerId,
              agentId: resolvedAgentId,
              agentVisibility: agentConfig.visibility,
              operationId: context.operationId,
              // Sandbox providers use a conversation key; each Native session stays isolated.
              topicId: metadata?.topicId,
              toolCallId: call.id,
              toolManifestMap: context.effectiveManifestMap,
              skipResultTruncation: true,
              activatedSkills: context.activatedSkills as StepActivatedSkill[] | undefined,
              currentTodos: context.currentTodos,
              activeDeviceId: resolveRunActiveDeviceId(metadata),
              activeDeviceScope: metadata?.activeDeviceScope,
              deviceCapable: plan ? isDeviceCapablePlan(plan) : undefined,
              deviceExecutionTarget: plan?.target,
              localSandbox: plan
                ? isLocalSandboxEnabled(agentConfig.agencyConfig, plan.target)
                : undefined,
              localSandboxNetwork: agentConfig.agencyConfig?.localSandboxNetwork === true,
              memoryToolPermission: agentConfig.chatConfig?.memory?.toolPermission,
              workingDirectory: metadata?.deviceSystemInfo?.workingDirectory,
              executionTimeoutMs: resolveToolTimeoutMs({
                apiName: call.apiName,
                args: context.parsedArgs,
                manifest,
              }),
            },
          ),
        };
      },
    },
  };
}
