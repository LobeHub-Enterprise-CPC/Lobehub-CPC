import { builtinSkills } from '@lobechat/builtin-skills';
import { SkillEngine } from '@lobechat/context-engine';
import type { LobeChatDatabase } from '@lobechat/database';
import { resourcesTreePrompt } from '@lobechat/prompts';
import type { WorkspaceInitResult } from '@lobechat/types';
import { getActivePluginIds } from '@lobechat/types';
import debug from 'debug';

import { AgentSkillModel } from '@/database/models/agentSkill';
import { type ExecutionPlan, isDeviceCapablePlan } from '@/helpers/executionTarget';
import { shouldEnableBuiltinSkill } from '@/helpers/skillFilters';
import type { AgentConfigWithId } from '@/server/services/agent';
import type { AgentDocumentsService } from '@/server/services/agentDocuments';

import { type AgentShareGate, filterPluginsByShareGate } from '../shareGate';

const log = debug('lobe-server:ai-agent-service');

/** Shared skill candidates, pinned content, disabled entries and project instructions. */
export async function prepareOperationSkills(
  deps: {
    db: LobeChatDatabase;
    userId: string;
    workspaceId?: string;
    agentDocumentsService: AgentDocumentsService;
  },
  input: {
    agentConfig: AgentConfigWithId;
    agentPlugins: string[];
    disabledPluginIds: string[];
    executionPlan?: ExecutionPlan;
    resolvedAgentId: string;
    shareGate?: AgentShareGate;
    workspace?: WorkspaceInitResult;
  },
) {
  const {
    agentConfig,
    agentPlugins,
    disabledPluginIds,
    executionPlan,
    resolvedAgentId,
    shareGate,
  } = input;
  const activeDeviceId = executionPlan?.kind === 'device' ? executionPlan.deviceId : undefined;
  const workspaceInit = { workspace: input.workspace ?? { instructions: [], skills: [] } };
  try {
    const builtinMetas = builtinSkills.map((s) => ({
      content: s.content,
      description: s.description,
      identifier: s.identifier,
      name: s.name,
    }));
    const skillModel = new AgentSkillModel(deps.db, deps.userId, deps.workspaceId);
    const { data: dbSkills } = await skillModel.findAll();

    // Pinned skills need their SKILL.md body injected into context directly,
    // not lazily via the `activateSkill` tool. Gate on the agent's genuinely
    // pinned entries (`getActivePluginIds(agentConfig.plugins)`), NOT the
    // fully-expanded `agentPlugins`: the latter also carries turn-scoped tool
    // ids (mentions, selected tools, `lobe-topic-reference`, …), which would
    // eager-activate an auto-mode skill whose identifier merely collides with
    // one of them. `findAll` uses `skillListColumns` (no `content`), so fetch
    // bodies only for the pinned subset to keep the op-param payload bounded.
    // Non-pinned skills stay content-less here and remain lazily activatable.
    // Content lives in the DB `content` column already (SKILL.md body), so no
    // zip unpack is needed; mirror `activateSkill` by appending the resource
    // tree so pinned ZIP/GitHub skills keep their `readReference` paths.
    const pinnedSkillIds = new Set(getActivePluginIds(agentConfig.plugins));
    const pinnedDbSkillIds = dbSkills
      .filter((s) => pinnedSkillIds.has(s.identifier))
      .map((s) => s.id);
    const pinnedDbContent = new Map(
      (await skillModel.findByIds(pinnedDbSkillIds)).map((s) => {
        const hasResources = !!(s.resources && Object.keys(s.resources).length > 0);
        const content =
          hasResources && s.resources
            ? `${s.content ?? ''}\n\n${resourcesTreePrompt(s.name, s.resources)}`
            : (s.content ?? undefined);
        return [s.identifier, content] as const;
      }),
    );
    const dbMetas = dbSkills.map((s) => ({
      content: pinnedDbContent.get(s.identifier),
      description: s.description ?? '',
      identifier: s.identifier,
      name: s.name,
    }));

    // Agent-document skill bundles surfaced as runtime skills via the shared
    // `getAgentSkills` source of truth (prefix + index-child resolution lives
    // there; see `AgentDocumentsService.getAgentSkills`). Identifier is
    // prefixed (`agent-skills:<filename>`) so it can't collide with builtin
    // / DB skill names, and we re-use it as `name` so the prompt's
    // `<skill name="...">` line and the model's `activateSkill(name)` call
    // carry the same value.
    const agentSkills = await deps.agentDocumentsService.getAgentSkills(resolvedAgentId);
    const agentSkillMetas = agentSkills.map((skill) => ({
      // `getAgentSkills` already resolves the bundle body, so pinned
      // agent-document skills inject directly without an extra fetch; only
      // attach it for the pinned subset to keep the payload lean.
      content: pinnedSkillIds.has(skill.identifier) ? skill.content : undefined,
      description: skill.description,
      identifier: skill.identifier,
      name: skill.name,
    }));

    const projectMetas = workspaceInit.workspace.skills.map((s) => ({
      description: s.description ?? '',
      identifier: `${s.scope === 'device' ? 'device' : 'project'}:${s.name}`,
      location: s.path,
      name: s.name,
      source: s.scope === 'device' ? ('device' as const) : ('project' as const),
    }));

    if (projectMetas.length) {
      log(
        'execAgent: workspace skills merged: %d (activeDeviceId=%s)',
        projectMetas.length,
        activeDeviceId ?? 'none',
      );
    }

    // Inject the project-root agent instructions (AGENTS.md / CLAUDE.md) as
    // trailing blocks on the system role — after the agent's persona and any
    // page/task/additional instructions. `agentConfig` is read by
    // `createOperation` below, so appending here still reaches the LLM.
    if (workspaceInit.workspace.instructions.length) {
      const block = workspaceInit.workspace.instructions
        .map(
          ({ content, source }) =>
            `<project_instructions source="${source}">\n${content}\n</project_instructions>`,
        )
        .join('\n\n');
      agentConfig.systemRole = agentConfig.systemRole
        ? `${agentConfig.systemRole}\n\n${block}`
        : block;
      log(
        'execAgent: injected %d project instruction file(s): %s',
        workspaceInit.workspace.instructions.length,
        workspaceInit.workspace.instructions.map((i) => i.source).join(', '),
      );
    }

    // Precedence on name collision: project > db > agent-skills > builtin.
    // Agent-skills carry the `agent-skills:` prefix in their `name`, so they
    // can only collide with each other — but we still dedupe by name to keep
    // a single shape for the SkillEngine input.
    //
    // Disabled skills are dropped here, not just rule-gated later: this
    // `skills` array is the sole candidate pool SkillEngine/SkillResolver
    // build `<available_skills>` from AND the pool `activateSkill` resolves
    // against, so a disabled identifier absent here is neither listed nor
    // activatable — mirrors the tool-manifest treatment above (installedPlugins/
    // additionalManifests), which this array had never received.
    //
    // Shared runs only see skills allowed by the share configuration. The
    // candidate pool must be trimmed here rather than left to
    // `SkillEngine.generate`, which annotates activation state on its input
    // rather than shrinking it. Reuse `filterPluginsByShareGate` (id-list
    // intersection, not tool-specific) to keep this pool the single
    // enforcement point — an empty/missing allowlist collapses it to nothing.
    const shareAllowedSkillIds = shareGate
      ? new Set(
          filterPluginsByShareGate(
            [...projectMetas, ...dbMetas, ...agentSkillMetas, ...builtinMetas].map(
              (skill) => skill.identifier,
            ),
            shareGate,
          ),
        )
      : undefined;
    const seenNames = new Set<string>();
    const skills = [...projectMetas, ...dbMetas, ...agentSkillMetas, ...builtinMetas].filter(
      (skill) => {
        if (disabledPluginIds.includes(skill.identifier)) return false;
        if (shareAllowedSkillIds && !shareAllowedSkillIds.has(skill.identifier)) return false;
        if (seenNames.has(skill.name)) return false;
        seenNames.add(skill.name);
        return true;
      },
    );

    // Device-only builtin skills (agent-browser) are gated on the run's
    // execution plan, not the compile-time `isDesktop` constant (always false
    // on the server). Gate the static `<available_skills>` listing on the
    // device-CAPABLE plan rather than `activeDeviceId`: `device-unrouted`
    // runs let the model pick a device mid-run, and this skill set is built
    // once per operation — gating on `activeDeviceId` would hide the skill
    // forever in those runs. Activation/loading apply the same plan gate via
    // `ToolExecutionContext.deviceCapable`; only actual command execution is
    // gated at the device tool layer.
    const skillEngine = new SkillEngine({
      enableChecker: (skill) =>
        shouldEnableBuiltinSkill(skill.identifier, {
          canExecuteOnDevice: executionPlan ? isDeviceCapablePlan(executionPlan) : false,
        }),
      skills,
    });
    return skillEngine.generate(agentPlugins ?? []);
  } catch (error) {
    log('execAgent: failed to build operationSkillSet: %O', error);
  }
}
