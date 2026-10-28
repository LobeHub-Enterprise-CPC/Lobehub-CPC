import type { LobeChatDatabase } from '@lobechat/database';

import { insertLog } from './logsRepository';
import { isGovernanceEnabled } from './policyGate';
import type { CommandGovernanceContext, CommandGovernanceOutcome } from './types';

/** Persist audit records best effort. Report failures without masking the tool result. */
export const logCommandExecution = async (
  ctx: CommandGovernanceContext,
  outcome: CommandGovernanceOutcome,
  db: LobeChatDatabase,
): Promise<void> => {
  try {
    if (!(await isGovernanceEnabled(ctx.userId))) return;
    await insertLog(db, { ...ctx, outcome });
  } catch (error) {
    console.error('[governance] audit record was not persisted: %O', error);
  }
};
