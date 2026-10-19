import type { LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';

import { insertLog } from './logsRepository';
import { isGovernanceEnabledBestEffort } from './policyGate';
import type { CommandGovernanceContext, CommandGovernanceOutcome } from './types';

const log = debug('lobe-server:governance:audit-logger');

/**
 * Persist one row to `command_execution_logs`. No-op when governance is
 * disabled for the user (`policyGate.isGovernanceEnabledBestEffort`, an unreadable flag counts as off: an audit write never fails the tool call it records) — no log write on
 * the hot path when the feature is off.
 *
 * Callers must never let a logging failure mask the real tool result: this
 * function does not throw — a DB error here is swallowed and debug-logged
 * only, matching the fail-open posture of `checkCommand`.
 */
export const logCommandExecution = async (
  ctx: CommandGovernanceContext,
  outcome: CommandGovernanceOutcome,
  db: LobeChatDatabase,
): Promise<void> => {
  if (!(await isGovernanceEnabledBestEffort(ctx.userId))) return;

  try {
    await insertLog(db, { ...ctx, outcome });
  } catch (error) {
    log('Failed to persist command execution audit log for user %s: %O', ctx.userId, error);
  }
};
