/** CPC models migrated by Enterprise, outside the upstream migration chain. */
// Named exports also work when ESM consumers load this CommonJS package via tsx.
export {
  channelApprovals,
  channelAudit,
  channelDiscussions,
  channelJobs,
  channelMembers,
  channelMessages,
  channelOutbox,
  channelRuns,
  channelRuntimeMessages,
  channelRuntimeStates,
  channels,
  channelSessions,
  channelThreads,
} from './channel';
export type {
  CommandExecutionLogItem,
  CommandExecutionLogPolicyField,
  CommandExecutionTargetDB,
  CommandGovernancePatternType,
  CommandGovernanceRuleItem,
  CommandGovernanceScope,
  NewCommandExecutionLog,
  NewCommandGovernanceRule,
  NewUserExecutionPolicy,
  UserExecutionPolicyCommandMode,
  UserExecutionPolicyItem,
} from './governance';
export {
  commandExecutionLogPolicyFields,
  commandExecutionLogs,
  commandExecutionTargets,
  commandGovernancePatternTypes,
  commandGovernanceRules,
  commandGovernanceScopes,
  userExecutionPolicies,
  userExecutionPolicyCommandModes,
} from './governance';
