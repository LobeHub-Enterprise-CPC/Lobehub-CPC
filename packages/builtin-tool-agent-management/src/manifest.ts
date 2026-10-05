import { EXTERNAL_INTEGRATIONS_ENABLED } from '@lobechat/business-const';
import type { BuiltinToolManifest } from '@lobechat/types';

import { systemPrompt } from './systemRole';
import { AgentManagementApiName, AgentManagementIdentifier } from './types';

// Tool descriptions are sent to the model with the tool list, so these
// advertise integrations exactly as the system prompt does. Gating only the
// prompt leaves the model reading "Composio integrations" off the tool schema.
const installPluginDesc = EXTERNAL_INTEGRATIONS_ENABLED
  ? "Install a plugin/tool for an agent. Use 'official' source for builtin tools, Composio integrations, and LobehubSkill providers. Use 'market' source for MCP marketplace plugins."
  : "Install a plugin/tool for an agent. Use 'official' source for builtin tools. Use 'market' source for MCP marketplace plugins.";

const pluginSourceDesc = EXTERNAL_INTEGRATIONS_ENABLED
  ? "Plugin source: 'official' (builtin tools, Composio, LobehubSkill) or 'market' (MCP marketplace)"
  : "Plugin source: 'official' (builtin tools) or 'market' (MCP marketplace)";

export const AgentManagementManifest: BuiltinToolManifest = {
  api: [
    // ==================== Agent CRUD ====================
    {
      description:
        'Create a new AI agent with custom configuration. The agent will be added to your workspace and can be used for conversations or tasks.',
      name: AgentManagementApiName.createAgent,
      parameters: {
        properties: {
          title: {
            description: 'The display name for the agent (required)',
            type: 'string',
          },
          description: {
            description: 'A brief description of what the agent does',
            type: 'string',
          },
          systemRole: {
            description:
              "The system prompt that defines the agent's personality, expertise, and behavior. This is the core instruction for the agent.",
            type: 'string',
          },
          avatar: {
            description: 'Agent avatar (emoji like "🤖" or image URL)',
            type: 'string',
          },
          backgroundColor: {
            description: 'Background color for the agent card (hex color code)',
            type: 'string',
          },
          // No example ids here on purpose. Examples naming real upstream
          // vendors read as the expected shape of an answer, and a model with no
          // list to hand copies that shape — inferring a vendor from the model
          // name instead of using the deployment's own provider id. Both fields
          // must come from `available_models` in the injected context, which is
          // the only place that knows what this deployment serves.
          model: {
            description:
              'Model id, copied exactly from the `available_models` section of the injected context. Must be paired with the `provider` it is listed under.',
            type: 'string',
          },
          provider: {
            description:
              'Provider id, copied exactly from the `available_models` section of the injected context. Never infer it from the model name or vendor.',
            type: 'string',
          },
          plugins: {
            description: 'Array of plugin identifiers to enable for this agent',
            items: { type: 'string' },
            type: 'array',
          },
          openingMessage: {
            description: 'Welcome message displayed when starting a new conversation',
            type: 'string',
          },
          openingQuestions: {
            description: 'Suggested questions to help users start the conversation',
            items: { type: 'string' },
            type: 'array',
          },
          tags: {
            description: 'Tags for categorizing the agent',
            items: { type: 'string' },
            type: 'array',
          },
        },
        required: ['title'],
        type: 'object',
      },
    },
    {
      description:
        'Update an existing agent configuration. Only include fields you want to change.',
      name: AgentManagementApiName.updateAgent,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to update',
            type: 'string',
          },
          config: {
            description: 'Partial agent configuration to update',
            properties: {
              model: {
                description:
                  'Model id, copied exactly from the `available_models` section of the injected context. Must be paired with the `provider` it is listed under.',
                type: 'string',
              },
              provider: {
                description:
                  'Provider id, copied exactly from the `available_models` section of the injected context. Never infer it from the model name or vendor.',
                type: 'string',
              },
              systemRole: {
                description: 'The system prompt',
                type: 'string',
              },
              plugins: {
                description: 'Array of enabled plugin identifiers',
                items: { type: 'string' },
                type: 'array',
              },
              openingMessage: {
                description: 'Opening message for new conversations',
                type: 'string',
              },
              openingQuestions: {
                description: 'Suggested opening questions',
                items: { type: 'string' },
                type: 'array',
              },
            },
            type: 'object',
          },
          meta: {
            description: 'Partial metadata to update',
            properties: {
              title: {
                description: 'Agent display name',
                type: 'string',
              },
              description: {
                description: 'Agent description',
                type: 'string',
              },
              avatar: {
                description: 'Agent avatar',
                type: 'string',
              },
              backgroundColor: {
                description: 'Background color',
                type: 'string',
              },
              tags: {
                description: 'Tags for categorization',
                items: { type: 'string' },
                type: 'array',
              },
            },
            type: 'object',
          },
        },
        required: ['agentId'],
        type: 'object',
      },
    },
    {
      description:
        'Delete an agent from your workspace. This action cannot be undone. The agent and its associated session will be removed.',
      humanIntervention: 'required',
      name: AgentManagementApiName.deleteAgent,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to delete',
            type: 'string',
          },
        },
        required: ['agentId'],
        type: 'object',
      },
    },

    {
      description:
        'Get the detailed configuration and metadata of an agent, including its system prompt, model, provider, plugins, and other settings. For heterogeneous agents (external CLI/runtime such as Claude Code or Codex) the result also describes the external runtime and its capabilities (filesystem/shell access, where it runs) — use this to judge whether the agent can carry out coding/software-engineering tasks.',
      name: AgentManagementApiName.getAgentDetail,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to get details for',
            type: 'string',
          },
        },
        required: ['agentId'],
        type: 'object',
      },
    },
    {
      description:
        'Duplicate an existing agent to create a copy with the same configuration. Optionally provide a new title for the duplicated agent.',
      name: AgentManagementApiName.duplicateAgent,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to duplicate',
            type: 'string',
          },
          newTitle: {
            description:
              'Optional new title for the duplicated agent. If not provided, the original title with a "Copy" suffix will be used.',
            type: 'string',
          },
        },
        required: ['agentId'],
        type: 'object',
      },
    },
    {
      description: installPluginDesc,
      name: AgentManagementApiName.installPlugin,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to install the plugin for',
            type: 'string',
          },
          identifier: {
            description: 'The plugin identifier to install',
            type: 'string',
          },
          source: {
            description: pluginSourceDesc,
            enum: ['official', 'market'],
            type: 'string',
          },
        },
        required: ['agentId', 'identifier', 'source'],
        type: 'object',
      },
    },

    // ==================== Prompt ====================
    {
      description:
        "Update an agent's system prompt. Use this instead of updateAgent when you only need to change the system prompt — it's simpler, avoids nested config objects, and clears stale editor data automatically.",
      name: AgentManagementApiName.updatePrompt,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to update the prompt for',
            type: 'string',
          },
          prompt: {
            description: 'The new system prompt content',
            type: 'string',
          },
        },
        required: ['agentId', 'prompt'],
        type: 'object',
      },
    },

    // ==================== Search ====================
    {
      description:
        "Search for agents in your workspace or the marketplace. Use 'user' source to find your own agents, 'market' for marketplace agents, or 'all' for both. Results are paginated: the response reports the real total, and you can page through workspace agents with 'offset'. Each result carries an `origin` (workspace/market) and, for heterogeneous agents, a `heteroType` (e.g. claude-code, codex) — those are backed by an external CLI/device runtime and can execute coding/agentic tasks directly, so you can hand a task to them without further setup.",
      name: AgentManagementApiName.searchAgent,
      parameters: {
        properties: {
          keyword: {
            description: 'Search keywords to find agents by name or description',
            type: 'string',
          },
          source: {
            description:
              "Where to search: 'user' (your agents), 'market' (marketplace), 'all' (both). Default: 'all'",
            enum: ['user', 'market', 'all'],
            type: 'string',
          },
          category: {
            description:
              'Category filter for marketplace search (e.g., "programming", "writing", "translation")',
            type: 'string',
          },
          limit: {
            default: 10,
            description: 'Maximum number of results to return (default: 10, max: 20)',
            type: 'number',
          },
          offset: {
            default: 0,
            description:
              'Number of workspace agents to skip, for pagination (e.g. offset=20 with limit=20 returns agents 21-40). Not applied to marketplace results.',
            type: 'number',
          },
        },
        required: [],
        type: 'object',
      },
    },

    // ==================== Execution ====================
    {
      description: 'Call an agent to handle a specific task or respond to an instruction.',
      name: AgentManagementApiName.callAgent,
      parameters: {
        properties: {
          agentId: {
            description: 'The ID of the agent to call',
            type: 'string',
          },
          instruction: {
            description:
              'The instruction or task for the agent to execute. Be specific about expected deliverables.',
            type: 'string',
          },
          skipCallSupervisor: {
            default: false,
            description:
              'If true (and in a group context), the orchestration will end after this agent responds, without calling the supervisor again. Only relevant when used within agent groups.',
            type: 'boolean',
          },
        },
        required: ['agentId', 'instruction'],
        type: 'object',
      },
    },
  ],
  identifier: AgentManagementIdentifier,
  meta: {
    avatar: '🤖',
    description: 'Create, manage, and orchestrate AI agents',
    title: 'Agent Management',
  },
  systemRole: systemPrompt,
  type: 'builtin',
};

export { AgentManagementApiName, AgentManagementIdentifier } from './types';
