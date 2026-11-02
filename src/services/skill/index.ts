import type {
  CreateSkillInput,
  ImportGitHubInput,
  ImportUrlInput,
  ImportZipInput,
  SkillImportResult,
  SkillItem,
  SkillListItem,
  SkillResourceContent,
  SkillResourceTreeNode,
  SkillSource,
  UpdateSkillInput,
} from '@lobechat/types';

import { lambdaClient } from '@/libs/trpc/client';

class AgentSkillService {
  // ===== Create =====

  async createSkill(params: CreateSkillInput): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.create.mutate(params);
  }

  // ===== Import =====

  async importFromGitHub(params: ImportGitHubInput): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromGitHub.mutate(params);
  }

  async importFromUrl(params: ImportUrlInput): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromUrl.mutate(params);
  }

  async importFromZip(params: ImportZipInput): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromZip.mutate(params);
  }

  /** Installed Market skills/plugins the enterprise no longer makes available to this member. */
  async listRevokedMarketAssets(): Promise<string[]> {
    return lambdaClient.agentSkills.listRevokedMarketAssets.query();
  }

  /**
   * Skill lookups for the agent's skill tools: installed Market skills the enterprise no longer
   * makes available are treated as absent, so a model-supplied name cannot activate them.
   */
  async listUsable(): Promise<{ data: SkillListItem[]; total: number }> {
    const [skills, revoked] = await Promise.all([this.list(), this.listRevokedMarketAssets()]);
    if (revoked.length === 0) return skills;
    const data = skills.data.filter((skill) => !revoked.includes(skill.identifier));
    return { data, total: data.length };
  }

  async getUsableById(id: string): Promise<SkillItem | undefined> {
    return this.withoutRevoked(await this.getById(id));
  }

  async getUsableByName(name: string): Promise<SkillItem | undefined> {
    return this.withoutRevoked(await this.getByName(name));
  }

  private async withoutRevoked(skill: SkillItem | undefined) {
    if (!skill) return skill;
    const revoked = await this.listRevokedMarketAssets();
    return revoked.includes(skill.identifier) ? undefined : skill;
  }

  async importFromMarket(identifier: string): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromMarket.mutate({ identifier });
  }

  /**
   * Make sure the Market skills an agent references are installed in the active
   * scope. Per-identifier outcomes; a failed one never throws.
   */
  async ensureFromMarket(identifiers: string[]) {
    return lambdaClient.agentSkills.ensureFromMarket.mutate({ identifiers });
  }

  // ===== Query =====

  async getById(id: string): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.getById.query({ id });
  }

  async getZipUrl(id: string): Promise<{ name: string; url: string | null }> {
    return lambdaClient.agentSkills.getByIdWithZipUrl.query({ id });
  }

  async getByIdentifier(identifier: string): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.getByIdentifier.query({ identifier });
  }

  async getByName(name: string): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.getByName.query({ name });
  }

  async list(source?: SkillSource): Promise<{ data: SkillListItem[]; total: number }> {
    return lambdaClient.agentSkills.list.query(source ? { source } : undefined);
  }

  async search(query: string): Promise<{ data: SkillListItem[]; total: number }> {
    return lambdaClient.agentSkills.search.query({ query });
  }

  // ===== Resources =====

  async listResources(id: string, includeContent?: boolean): Promise<SkillResourceTreeNode[]> {
    return lambdaClient.agentSkills.listResources.query({ id, includeContent });
  }

  async readResource(id: string, path: string): Promise<SkillResourceContent> {
    return lambdaClient.agentSkills.readResource.query({ id, path });
  }

  // ===== Update =====

  async updateSkill(params: UpdateSkillInput): Promise<SkillItem> {
    return lambdaClient.agentSkills.update.mutate({
      content: params.content,
      id: params.id,
      manifest: params.manifest,
    });
  }

  // ===== Delete =====

  // Server keeps delete idempotent: a missing row resolves to undefined.
  async deleteSkill(id: string): Promise<{ success: boolean } | undefined> {
    return lambdaClient.agentSkills.delete.mutate({ id });
  }
}

export type EnsureMarketSkillResult = Awaited<
  ReturnType<AgentSkillService['ensureFromMarket']>
>[number];

export const agentSkillService = new AgentSkillService();
