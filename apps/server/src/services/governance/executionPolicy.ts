import type { LobeChatDatabase } from '@lobechat/database';

import { getPolicyForUser } from './executionPolicyRepository';
import { GovernanceUnavailableError, isGovernanceEnabled } from './policyGate';
import type { ResolvedExecutionPolicy } from './types';

/**
 * Resolve the execution policy the CLI/desktop should enforce for one user,
 * or `null` when there is none — no row, the row is disabled, or the
 * governance feature flag is off. `null` means "unrestricted": the caller
 * falls back to its existing behavior, never to "deny everything".
 *
 * Unreadable switches and policy lookup failures reject with GovernanceUnavailableError.
 * A successful lookup with no enabled policy remains unrestricted.
 */
export const getUserExecutionPolicy = async (
  userId: string,
  db: LobeChatDatabase,
): Promise<ResolvedExecutionPolicy | null> => {
  if (!(await isGovernanceEnabled(userId))) return null;

  try {
    const row = await getPolicyForUser(db, userId);
    if (!row || !row.enabled) return null;

    return {
      allowedNetworkDomains: row.allowedNetworkDomains ?? undefined,
      allowNetwork: row.allowNetwork,
      commandMode: row.commandMode,
      deniedReadRoots: row.deniedReadRoots ?? undefined,
      deniedWriteRoots: row.deniedWriteRoots ?? undefined,
      enabled: row.enabled,
      envAllowlist: row.envAllowlist ?? undefined,
      readableRoots: row.readableRoots ?? undefined,
      writableRoots: row.writableRoots,
    };
  } catch (error) {
    console.error('[governance] execution policy unavailable: %O', error);
    throw new GovernanceUnavailableError({ cause: error });
  }
};
