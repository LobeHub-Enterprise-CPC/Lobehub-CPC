import { LobeAgentApiName, LobeAgentIdentifier } from '@lobechat/builtin-tool-lobe-agent';

/** Retained dispatch guard for historical visitor operation records. */
export const SUB_AGENT_DISPATCH_APIS: Record<string, { apiName: string }> = {
  [LobeAgentIdentifier]: { apiName: LobeAgentApiName.callSubAgent },
};
