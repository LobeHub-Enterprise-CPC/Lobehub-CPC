import type { AgentShareToolGrant } from '@lobechat/types';

export interface ShareDataToolPermissions {
  allowReadMemory?: boolean;

  knowledgeBaseIds?: string[];

  skillGrants?: string[];
  toolGrants?: AgentShareToolGrant[];
}
