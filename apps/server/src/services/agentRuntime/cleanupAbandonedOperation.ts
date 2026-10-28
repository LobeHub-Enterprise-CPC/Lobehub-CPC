import type { GatewayExecutionContext } from '@lobechat/types';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { agentOperations } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/** Retire only the exact execution read here; no hooks or parent execution. */
export const cleanupAbandonedOperation = async (
  db: LobeChatDatabase,
  operationId: string,
  expectedExecution?: GatewayExecutionContext & { parentOperationId?: string | null },
) => {
  const [row] = await db.select().from(agentOperations).where(eq(agentOperations.id, operationId));
  if (
    !row ||
    (expectedExecution &&
      (row.metadata?.tenantId !== expectedExecution.tenantId ||
        row.metadata?.sourceAcceptedVersion !== expectedExecution.sourceAcceptedVersion ||
        ('parentOperationId' in expectedExecution &&
          row.parentOperationId !== expectedExecution.parentOperationId)))
  )
    return false;
  const updated = await db
    .update(agentOperations)
    .set({
      status: 'error',
      completionReason: 'error',
      completedAt: new Date(),
    })
    .where(
      and(
        eq(agentOperations.id, operationId),
        eq(agentOperations.userId, row.userId),
        row.parentOperationId
          ? eq(agentOperations.parentOperationId, row.parentOperationId)
          : isNull(agentOperations.parentOperationId),
        row.metadata
          ? eq(agentOperations.metadata, row.metadata)
          : isNull(agentOperations.metadata),
        inArray(agentOperations.status, [
          'running',
          'waiting_for_human',
          'waiting_for_async_tool',
          'waiting_for_client',
        ]),
      ),
    )
    .returning({ id: agentOperations.id });
  return updated.length === 1;
};
