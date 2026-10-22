import { currentTenantScope } from '@lobechat/database/tenant';
import { and, eq, exists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { agentOperations } from '../schemas/agentOperations';
import type { LobeChatDatabase } from '../type';

/** Applied in the final parent resume UPDATE, including the original child link. */
export const gatewayExecutionCondition = (
  db: Pick<LobeChatDatabase, 'select'>,
  childOperationId?: string,
) => {
  const scope = currentTenantScope();
  if (!scope) return;
  const execution = JSON.stringify({
    tenantId: scope.tenantId,
    sourceAcceptedVersion: scope.acceptedVersion,
  });
  const child = alias(agentOperations, 'gateway_resume_child');
  return and(
    sql`${agentOperations.metadata} @> ${execution}::jsonb`,
    childOperationId
      ? exists(
          db
            .select({ id: child.id })
            .from(child)
            .where(
              and(
                eq(child.id, childOperationId),
                eq(child.parentOperationId, agentOperations.id),
                eq(child.userId, agentOperations.userId),
                sql`${child.metadata} @> ${execution}::jsonb`,
              ),
            ),
        )
      : undefined,
  );
};
