import { SkillsManifest } from '@lobechat/builtin-tool-skills';
import { SkillsExecutionRuntime } from '@lobechat/builtin-tool-skills/executionRuntime';
import { WebBrowsingManifest } from '@lobechat/builtin-tool-web-browsing';
import { ToolsEngine } from '@lobechat/context-engine';
import { getModelPropertyWithFallback } from '@lobechat/model-runtime';
import type { ChannelMemberConfig } from '@lobechat/types';
import { getActivePluginIds } from '@lobechat/types';
import { isRecord } from '@lobechat/utils/object';

import { AgentModel } from '@/database/models/agent';
import { AgentSkillModel } from '@/database/models/agentSkill';
import { AiModelModel } from '@/database/models/aiModel';
import { PluginModel } from '@/database/models/plugin';
import type { LobeChatDatabase } from '@/database/type';
import { mcpService } from '@/server/services/mcp';
import { SkillResourceService } from '@/server/services/skill/resource';
import { ToolExecutionService } from '@/server/services/toolExecution';

import type { ChannelNativeCapabilities } from './host';

/** Resolve personal Native tools once; unsupported integrations fail explicitly. */
export async function loadChannelNativeCapabilities(
  db: LobeChatDatabase,
  ownerId: string,
  config: ChannelMemberConfig,
): Promise<ChannelNativeCapabilities> {
  const agent = config.agentId
    ? await new AgentModel(db, ownerId).getAgentConfigById(config.agentId)
    : null;
  if (config.agentId && !agent) throw new Error('Native agent is no longer accessible');
  const installedPlugins = await new PluginModel(db, ownerId).query();
  const configuredModel = (
    await new AiModelModel(db, ownerId).getModelListByProviderId(config.provider)
  ).find((model) => model.id === config.model);
  const contextWindowTokens =
    configuredModel?.contextWindowTokens ||
    (await getModelPropertyWithFallback<number | undefined>(
      config.model,
      'contextWindowTokens',
      config.provider,
    ));
  if (!contextWindowTokens)
    throw new Error('Configure the Native model context-window size before activating this member');
  const selected = agent
    ? getActivePluginIds(agent.plugins || undefined)
    : [WebBrowsingManifest.identifier, SkillsManifest.identifier];
  if (agent && selected.includes(SkillsManifest.identifier))
    throw new Error(
      'This agent requires executable Skills. Channel currently supports instruction/reference Skills in its Native preset; use Codex for local skill scripts. The agent configuration was not modified.',
    );
  // This is an explicit Channel preset, not a filtered copy of a user's agent.
  const skillsManifest = {
    ...SkillsManifest,
    api: SkillsManifest.api.filter((api) => ['activateSkill', 'readReference'].includes(api.name)),
    systemRole:
      'Skills in this Channel Native preset provide instructions and reference files. Activate a relevant skill and follow its guidance. Shell scripts and cloud sandboxes are unavailable; disclose that limitation when a skill needs execution.',
  };
  const { data: skills } = selected.includes(SkillsManifest.identifier)
    ? await new AgentSkillModel(db, ownerId).findAll()
    : { data: [] };
  // Orchestration tools own legacy Tasks/Topics. Channel never invokes those stores.
  const excluded = new Set([
    'lobe-agent',
    'lobe-group-management',
    'lobe-agent-builder',
    'lobe-message',
    'lobe-goal',
    'lobe-self-iteration',
  ]);
  if (selected.some((id) => excluded.has(id)))
    throw new Error('This Native agent enables orchestration outside the Channel MVP');
  const supported = new Set([
    WebBrowsingManifest.identifier,
    SkillsManifest.identifier,
    ...installedPlugins
      .filter((plugin) => Boolean(plugin.customParams?.mcp))
      .map((plugin) => plugin.identifier),
  ]);
  if (selected.some((id) => !supported.has(id)))
    throw new Error('A configured Native capability does not yet have a Channel adapter');
  const engine = new ToolsEngine({
    manifestSchemas: [
      WebBrowsingManifest,
      skillsManifest,
      ...installedPlugins
        .filter((plugin) => Boolean(plugin.customParams?.mcp) && plugin.manifest)
        .map((plugin) => ({
          ...plugin.manifest!,
          type: 'mcp' as const,
          mcpParams: plugin.customParams?.mcp,
        })),
    ],
    functionCallChecker: () => true,
    defaultToolIds: [],
  });
  const generated = engine.generateToolsDetailed({
    toolIds: selected,
    model: config.model,
    provider: config.provider,
    skipDefaultTools: true,
  });
  if (generated.filteredTools.length)
    throw new Error(
      `Native tools unavailable: ${generated.filteredTools.map((tool) => tool.id).join(', ')}`,
    );
  const toolManifestMap = Object.fromEntries(
    generated.enabledManifests.map((manifest) => [manifest.identifier, manifest]),
  );
  const skillModel = new AgentSkillModel(db, ownerId);
  const skillRuntime = new SkillsExecutionRuntime({
    service: {
      findAll: () => skillModel.findAll(),
      findById: (id) => skillModel.findById(id),
      findByName: async (name) =>
        (await skillModel.findByName(name)) || (await skillModel.findByIdentifier(name)),
      readResource: async (id, path) => {
        const skill = await skillModel.findById(id);
        if (!skill) throw new Error('Skill is no longer accessible');
        return new SkillResourceService(db, ownerId).readResource(skill.resources || {}, path);
      },
    },
  });
  const service = new ToolExecutionService({
    mcpService,
    builtinToolsExecutor: {
      execute: async (call) => {
        if (call.identifier === WebBrowsingManifest.identifier) {
          const { WebBrowsingExecutionRuntime } =
            await import('@lobechat/builtin-tool-web-browsing/executionRuntime');
          const { SearchService } = await import('@/server/services/search');
          const runtime = new WebBrowsingExecutionRuntime({ searchService: new SearchService() });
          const fn = runtime[call.apiName as 'search'];
          if (typeof fn !== 'function') throw new Error('Unknown browsing tool');
          return fn.call(runtime, JSON.parse(call.arguments));
        }
        if (call.identifier === SkillsManifest.identifier) {
          if (call.apiName === 'activateSkill')
            return skillRuntime.activateSkill(JSON.parse(call.arguments));
          if (call.apiName === 'readReference')
            return skillRuntime.readReference(JSON.parse(call.arguments));
          throw new Error('The Channel Native preset does not execute Skill scripts');
        }
        throw new Error('Native builtin has no Channel adapter');
      },
    },
  });
  return {
    contextWindowTokens,
    compressionEnabled: agent?.chatConfig?.enableContextCompression ?? true,
    modelParameters: isRecord(agent?.params) ? agent.params : undefined,
    systemRole: [
      config.systemRole ?? agent?.systemRole,
      ...generated.enabledManifests.map((manifest) => manifest.systemRole),
      skills.length
        ? `Available personal Skills (call activateSkill by identifier):\n${JSON.stringify(skills.map((skill) => ({ identifier: skill.identifier, name: skill.name, description: skill.description })))}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tools: generated.tools || [],
    toolManifestMap,
    toolTransport: {
      maxRetries: 0,
      run: async (call, context) => {
        context.abortSignal?.throwIfAborted();
        if (
          !toolManifestMap[call.identifier]?.api.some((api) => api.name === call.apiName) ||
          excluded.has(call.identifier)
        )
          throw new Error('Tool is not authorized for this Channel member');
        return {
          attempts: 1,
          result: await service.executeTool(call, {
            serverDB: db,
            userId: ownerId,
            agentId: config.agentId,
            operationId: context.operationId,
            toolManifestMap: context.effectiveManifestMap,
            skipResultTruncation: true,
            activatedSkills: context.activatedSkills as any,
            activeDeviceId: config.deviceId,
            workingDirectory: config.workingDirectory,
            deviceExecutionTarget: config.deviceId ? 'device' : undefined,
          }),
        };
      },
    },
  };
}
