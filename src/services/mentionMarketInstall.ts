import { getActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import type {
  MarketInstallVisibility,
  PendingMarketAgent,
  PendingMarketSkill,
} from '@/features/ChatInput/InputEditor/marketMention';
import { agentService } from '@/services/agent';
import { discoverService } from '@/services/discover';
import {
  ensureAgentMarketSkills,
  ensureAgentMarketSkillsAndWarn,
} from '@/services/ensureAgentMarketSkills';
import { buildMarketAgentConfig } from '@/services/installMarketplaceAgents';
import { useAgentStore } from '@/store/agent';

/**
 * Readies the Market agents and skills picked from the composer's @ menu.
 *
 * Speed matters here because the send waits for it: the agent detail is
 * prefetched the moment the chip is picked, and the agent's own Market skills
 * are installed alongside its local row instead of after it.
 */

type AgentDetail = NonNullable<Awaited<ReturnType<typeof discoverService.getAssistantDetail>>>;

/** Cache successful lookups only, so a failed request is retried on the next attempt. */
const memoize = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = load();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
};

const detailCache = new Map<string, Promise<AgentDetail>>();
const installCache = new Map<string, Promise<string>>();

const loadAgentDetail = (identifier: string) =>
  memoize(detailCache, identifier, async () => {
    const detail = await discoverService.getAssistantDetail({ identifier });
    if (!detail?.config) throw new Error(`Market agent ${identifier} is unavailable`);
    return detail as AgentDetail;
  });

/** Warm the read-only part of an install while the user is still typing. */
export const prefetchMarketAgent = (identifier: string) => {
  loadAgentDetail(identifier).catch(() => {});
};

/**
 * Mentioning a Market agent runs it without installing it: the run needs a
 * local agent row (its prompt, model and tools), so the agent gets a hidden
 * (`virtual`) copy — kept out of the agent list and not forked to the Market —
 * that later mentions reuse. Installing it stays an explicit Market action.
 */
const prepareMarketAgent = (identifier: string, visibility: MarketInstallVisibility) => {
  const workspaceId = getActiveWorkspaceId();
  const key = `${workspaceId ?? ''}:${visibility}:${identifier}`;

  return memoize(installCache, key, async () => {
    const existing = await agentService.getAgentByForkedFromIdentifier(identifier, {
      virtual: true,
    });
    if (existing) return existing;

    const detail = await loadAgentDetail(identifier);
    const [result] = await Promise.all([
      useAgentStore.getState().createAgent({
        config: { ...buildMarketAgentConfig(detail, identifier), virtual: true },
        ...(workspaceId ? { visibility } : {}),
      }),
      ensureAgentMarketSkillsAndWarn(detail.config.plugins),
    ]);

    return result.agentId;
  });
};

export class MarketMentionInstallError extends Error {
  constructor(readonly failedNames: string[]) {
    super(`Failed to install: ${failedNames.join(', ')}`);
    this.name = 'MarketMentionInstallError';
  }
}

export interface MarketMentionInstallRequest {
  agents: PendingMarketAgent[];
  skills: PendingMarketSkill[];
}

/**
 * Install everything the message references from the Market, in parallel.
 * Resolves the installed agent id of each Market agent identifier; throws
 * `MarketMentionInstallError` naming whatever could not be installed.
 */
export const installMarketMentions = async ({
  agents,
  skills,
}: MarketMentionInstallRequest): Promise<Map<string, string>> => {
  const [agentResults, skillResults] = await Promise.all([
    Promise.allSettled(
      agents.map((agent) => prepareMarketAgent(agent.identifier, agent.visibility)),
    ),
    skills.length > 0
      ? ensureAgentMarketSkills(skills.map((skill) => skill.identifier))
      : Promise.resolve([]),
  ]);

  const installed = new Map<string, string>();
  const failedNames: string[] = [];

  agentResults.forEach((result, index) => {
    const agent = agents[index];
    if (result.status === 'fulfilled') installed.set(agent.identifier, result.value);
    else {
      console.error('[mention] failed to install market agent', agent.identifier, result.reason);
      failedNames.push(agent.label);
    }
  });
  const skillLabels = new Map(skills.map((skill) => [skill.identifier, skill.label]));
  for (const result of skillResults) {
    if (result.status === 'failed' || result.status === 'notSkill') {
      failedNames.push(skillLabels.get(result.identifier) ?? result.identifier);
    }
  }

  if (failedNames.length > 0) throw new MarketMentionInstallError(failedNames);
  return installed;
};
