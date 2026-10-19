import { requireTenantScope } from '@lobechat/database/tenant';
import { isAgentOperationInFlight } from '@lobechat/types';
import { and, eq, exists, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { getServerDB } from '@/database/core/db-adaptor';
import { agentOperations } from '@/database/schemas';
import { AbandonOperationService } from '@/server/services/agentRuntime/AbandonOperationService';
import { resumeAbandonedParent } from '@/server/services/agentRuntime/resumeAbandonedParent';
import { redisService } from '@/server/services/redis';

import { loadGatewayAttempt, sameBinding } from './attempts';
import { loadGatewayOperation } from './operationAuthority';
import type { GatewayFinalizeRequest } from './types';
import { GatewayAuthorizationError, samePrincipal } from './wire';

export const finalizeGatewayOperation = async (input: GatewayFinalizeRequest) => {
  const row = await loadGatewayOperation(input.operationId);
  const owner = { kind: 'user', id: row.userId };
  if (row.metadata?.sourceAcceptedVersion !== input.sourceAcceptedVersion)
    throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
  if (input.kind === 'operation-watchdog') {
    if (
      !samePrincipal(owner, input.ownerPrincipal) ||
      input.watchdog.firedAt < input.watchdog.lastEventAt
    )
      throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
  } else {
    const attempt = await loadGatewayAttempt(
      input.attemptId,
      input,
      input.dispatchBinding,
      input.operationId,
    );
    if (attempt.state !== 'claimed' || !sameBinding(attempt.dispatchBinding, input.dispatchBinding))
      throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  }
  const ack = (outcome: 'finalized' | 'already_terminal' | 'still_running' | 'rejected') => ({
    tenantId: input.tenantId,
    sourceAcceptedVersion: input.sourceAcceptedVersion,
    operationId: input.operationId,
    ...(input.kind === 'executor-attempt' ? { attemptId: input.attemptId } : {}),
    outcome,
  });
  if (!isAgentOperationInFlight(row.status)) return ack('already_terminal');
  const db = await getServerDB();
  const canResume = requireTenantScope().acceptedVersion === input.sourceAcceptedVersion;
  const result = await new AbandonOperationService(db).finalizeAbandoned(
    input.operationId,
    'inactivity_watchdog',
    {
      cleanupOnly: !canResume,
      expectedExecution: {
        tenantId: input.tenantId,
        sourceAcceptedVersion: input.sourceAcceptedVersion,
        parentOperationId: row.parentOperationId,
      },
    },
  );
  const settled = await loadGatewayOperation(input.operationId);
  if (
    settled.metadata?.sourceAcceptedVersion !== input.sourceAcceptedVersion ||
    !['done', 'error', 'interrupted', 'abandoned'].includes(settled.status)
  )
    return ack('still_running');
  await redisService.gatewayAuthorization.interruptOperation(
    input.operationId,
    input.sourceAcceptedVersion,
  );
  if (result.subAgentResume && canResume)
    await resumeAbandonedParent(db, input.operationId, result.subAgentResume);
  if (!canResume && row.parentOperationId) {
    const child = alias(agentOperations, 'gateway_finalized_child');
    const execution = JSON.stringify({
      tenantId: input.tenantId,
      sourceAcceptedVersion: input.sourceAcceptedVersion,
    });
    const updated = await db
      .update(agentOperations)
      .set({
        status: 'interrupted',
        error: { message: 'EXECUTION_UNKNOWN' },
        completedAt: new Date(),
      })
      .where(
        and(
          eq(agentOperations.id, row.parentOperationId),
          eq(agentOperations.userId, row.userId),
          sql`${agentOperations.metadata} @> ${execution}::jsonb`,
          exists(
            db
              .select({ id: child.id })
              .from(child)
              .where(
                and(
                  eq(child.id, input.operationId),
                  eq(child.parentOperationId, agentOperations.id),
                  eq(child.userId, agentOperations.userId),
                  sql`${child.metadata} @> ${execution}::jsonb`,
                  inArray(child.status, ['done', 'error', 'interrupted', 'abandoned']),
                ),
              ),
          ),
          inArray(agentOperations.status, [
            'running',
            'waiting_for_human',
            'waiting_for_async_tool',
            'waiting_for_client',
          ]),
        ),
      )
      .returning({ id: agentOperations.id });
    if (updated.length === 1)
      await redisService.gatewayAuthorization.interruptOperation(
        row.parentOperationId,
        input.sourceAcceptedVersion,
      );
  }
  return ack('finalized');
};
