import { getActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import type {
  MarketInstallVisibility,
  PendingMarketAgent,
  PendingMarketSkill,
} from '@/features/ChatInput/InputEditor/marketMention';
import { lambdaClient } from '@/libs/trpc/client';
import { discoverService } from '@/services/discover';
import {
  ensureAgentMarketSkills,
  ensureAgentMarketSkillsAndWarn,
} from '@/services/ensureAgentMarketSkills';
import {
  buildForkedAgentConfig,
  generateMarketIdentifier,
} from '@/services/installMarketplaceAgents';
import { marketApiService } from '@/services/marketApi';
import { useAgentStore } from '@/store/agent';
import { useHomeStore } from '@/store/home';

/**
 * Installs the Market agents and skills picked from the composer's @ menu.
 *
 * Speed matters here because the send waits for it: the agent detail is
 * prefetched the moment the chip is picked, the workspace's Market account is
 * resolved once per workspace, and the agent's own Market skills are installed
 * alongside the local agent row instead of after it.
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
const actAsCache = new Map<string, Promise<number | undefined>>();
const installCache = new Map<string, Promise<string>>();

const loadAgentDetail = (identifier: string) =>
  memoize(detailCache, identifier, async () => {
    const detail = await discoverService.getAssistantDetail({ identifier });
    if (!detail?.config) throw new Error(`Market agent ${identifier} is unavailable`);
    return detail as AgentDetail;
  });

/**
 * Workspace forks are attributed to the workspace's Market organization; see
 * `installMarketplaceAgents` for why `autoProvision` is set.
 */
const loadActAs = (workspaceId: string | null) =>
  workspaceId
    ? memoize(actAsCache, workspaceId, async () => {
        const { marketAccountId } = await lambdaClient.workspace.ensureMarketOrganization.mutate({
          autoProvision: true,
        });
        return marketAccountId;
      })
    : Promise.resolve(undefined);

/** Warm the read-only part of an install while the user is still typing. */
export const prefetchMarketAgent = (identifier: string) => {
  loadAgentDetail(identifier).catch(() => {});
};

const installMarketAgent = (identifier: string, visibility: MarketInstallVisibility) => {
  const workspaceId = getActiveWorkspaceId();
  const key = `${workspaceId ?? ''}:${visibility}:${identifier}`;

  return memoize(installCache, key, async () => {
    const [detail, actAs] = await Promise.all([
      loadAgentDetail(identifier),
      loadActAs(workspaceId),
    ]);

    const [forkOutcome] = await marketApiService.forkAgent([
      {
        actAs,
        identifier: generateMarketIdentifier(),
        name: detail.title,
        sourceIdentifier: identifier,
        status: 'published',
        visibility: 'public',
      },
    ]);
    if (!forkOutcome?.success) {
      throw new Error(forkOutcome?.error?.message || `Failed to fork market agent ${identifier}`);
    }
    const fork = forkOutcome.data.agent;

    const [result] = await Promise.all([
      useAgentStore.getState().createAgent({
        config: buildForkedAgentConfig(detail, fork, identifier),
        ...(workspaceId ? { visibility } : {}),
      }),
      ensureAgentMarketSkillsAndWarn(detail.config.plugins),
    ]);

    void useHomeStore.getState().refreshAgentList();
    discoverService.reportAgentEvent({
      event: 'add',
      identifier: fork.identifier,
      source: typeof location === 'undefined' ? 'chat-input/mention' : location.pathname,
    });

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
      agents.map((agent) => installMarketAgent(agent.identifier, agent.visibility)),
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
