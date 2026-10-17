import { currentTenantScope } from '@lobechat/database/tenant';
import { and, eq, inArray } from 'drizzle-orm';

import { agentOperations } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { gatewayExecutionCondition } from '@/database/utils/gatewayExecution';

/** Check before backfill/enqueue; the resume CAS repeats the execution/link predicate. */
export const gatewayParentMayResume = async (
  db: LobeChatDatabase,
  childOperationId: string,
  parentOperationId: string,
  userId: string,
) => {
  if (!currentTenantScope()) return true;
  const rows = await db
    .select({ id: agentOperations.id })
    .from(agentOperations)
    .where(
      and(
        eq(agentOperations.id, parentOperationId),
        eq(agentOperations.userId, userId),
        inArray(agentOperations.status, [
          'running',
          'waiting_for_human',
          'waiting_for_async_tool',
          'waiting_for_client',
        ]),
        gatewayExecutionCondition(db, childOperationId),
      ),
    );
  return rows.length === 1;
};
