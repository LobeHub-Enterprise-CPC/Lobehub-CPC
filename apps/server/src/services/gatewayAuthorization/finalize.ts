import { requireTenantScope } from '@lobechat/database/tenant';
import { and, eq, inArray } from 'drizzle-orm';

import { getServerDB } from '@/database/core/db-adaptor';
import { agentOperations } from '@/database/schemas';
import { resumeAbandonedParent } from '@/server/router-hono/agent/handlers/resumeAbandonedParent';
import { AbandonOperationService } from '@/server/services/agentRuntime/AbandonOperationService';
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
  if (
    !['running', 'waiting_for_human', 'waiting_for_async_tool', 'waiting_for_client'].includes(
      row.status,
    )
  )
    return ack('already_terminal');
  const db = await getServerDB();
  const canResume = requireTenantScope().acceptedVersion === input.sourceAcceptedVersion;
  const result = await new AbandonOperationService(db).finalizeAbandoned(
    input.operationId,
    'inactivity_watchdog',
    { cleanupOnly: !canResume },
  );
  await redisService.gatewayAuthorization.interruptOperation(input.operationId);
  if (result.subAgentResume && canResume)
    await resumeAbandonedParent(db, input.operationId, result.subAgentResume);
  if (!canResume && row.parentOperationId) {
    await db
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
          inArray(agentOperations.status, [
            'running',
            'waiting_for_human',
            'waiting_for_async_tool',
            'waiting_for_client',
          ]),
        ),
      );
    await redisService.gatewayAuthorization.interruptOperation(row.parentOperationId);
  }
  return ack(result.finalized || result.abandoned || result.found ? 'finalized' : 'still_running');
};
