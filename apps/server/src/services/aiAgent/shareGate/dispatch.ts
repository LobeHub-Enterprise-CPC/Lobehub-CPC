import { isShareToolApiGranted } from '@lobechat/const';
import type { AgentShareToolGrant } from '@lobechat/types';

import { isGovernedByBuiltinAllowlist, SHARE_VISITOR_ALLOWED_IDENTIFIERS } from './allowlist';
import { DATA_TOOL_ACCESS_RULES } from './dataToolRules';
import { resolveEffectiveShareToolGrants } from './grants';
import { SUB_AGENT_DISPATCH_APIS } from './subAgentDispatch';
import type { ShareDataToolPermissions } from './types';

export const isShareBlockedDataToolCall = (
  permissions: ShareDataToolPermissions,
  identifier: string,
  apiName: string,
  args?: any,
): boolean => {
  // Outside this gate's jurisdiction entirely — MCP/market/custom plugin
  // identifiers are governed by the toolGrants picker, not this allowlist.
  if (!isGovernedByBuiltinAllowlist(identifier)) return false;

  // Default-deny: a known builtin identifier not on the allowlist is blocked
  // unconditionally, including any tool registered after this allowlist was
  // written — the whole point of inverting a denylist.
  if (!SHARE_VISITOR_ALLOWED_IDENTIFIERS.has(identifier)) return true;

  const rule = DATA_TOOL_ACCESS_RULES[identifier];
  if (!rule) return false;

  const grant = rule.grant(permissions);
  if (grant === 'none') return true;

  if (rule.writeApiNames.includes(apiName)) return true;
  if (rule.alwaysBlockedApiNames?.includes(apiName)) return true;
  if (args !== undefined && rule.isArgsOutOfScope?.(permissions, apiName, args)) return true;

  return false;
};

export const isShareBlockedBuiltinDispatch = (
  agentShare: ShareDataToolPermissions & { toolGrants?: AgentShareToolGrant[] },
  identifier: string,
  apiName: string,
  args?: any,
): boolean => {
  if (!isGovernedByBuiltinAllowlist(identifier)) return false;

  if (!SHARE_VISITOR_ALLOWED_IDENTIFIERS.has(identifier)) return true;
  // The owner's picker must grant this identifier at all (toolset-level or
  // naming this specific `apiName`) — a grant scoped to a DIFFERENT api on
  // the same identifier does not authorize this call.
  if (!isShareToolApiGranted(resolveEffectiveShareToolGrants(agentShare), identifier, apiName))
    return true;

  if (SUB_AGENT_DISPATCH_APIS[identifier]?.apiName === apiName) return true;

  // `humanIntervention` is deliberately NOT re-checked here: share runs keep
  // the manifest's intervention config and honor the visitor's own approval
  // mode, so an intervention-gated call reaches this executor only after the
  // visitor approved it (or chose auto-run). Granting a tool grants its normal
  // approval flow.
  return isShareBlockedDataToolCall(agentShare, identifier, apiName, args);
};
