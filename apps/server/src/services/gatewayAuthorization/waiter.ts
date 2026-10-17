import { setTimeout } from 'node:timers/promises';

import { requireTenantScope } from '@lobechat/database/tenant';

import { redisService } from '@/server/services/redis';

import { assertGatewayVersion } from './index';
import { assertGatewaySource } from './sources';
import type { GatewayCallback, GatewayExecutionContext } from './types';
import { GatewayAuthorizationError } from './wire';

export interface GatewayResultKey {
  attemptId: string;
  operationId: string;
  toolCallId: string;
}

/** Polls the durable attempt, with authoritative lifecycle checks also in independent workers. */
export const waitForGatewayResult = async (
  key: GatewayResultKey,
  options: { signal: AbortSignal; execution: GatewayExecutionContext; expiresAt: number },
): Promise<GatewayCallback> => {
  const scope = requireTenantScope();
  const local = new AbortController();
  const signal = AbortSignal.any([options.signal, local.signal]);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const unbind = scope.trackWork?.({ close: () => local.abort(), settled });
  try {
    while (Date.now() < options.expiresAt) {
      signal.throwIfAborted();
      await assertGatewayVersion(
        options.execution.tenantId,
        options.execution.sourceAcceptedVersion,
      );
      const attempt = await redisService.gatewayAuthorization.getAttempt(key.attemptId);
      if (
        !attempt ||
        attempt.intent.operationId !== key.operationId ||
        attempt.intent.toolCallId !== key.toolCallId ||
        attempt.intent.tenantId !== options.execution.tenantId ||
        attempt.intent.sourceAcceptedVersion !== options.execution.sourceAcceptedVersion
      )
        throw new GatewayAuthorizationError('EXECUTION_UNKNOWN', 409);
      await assertGatewaySource(attempt.source, {
        principal: attempt.intent.targetPrincipal,
        operationId: key.operationId,
        execute: true,
      });
      if (attempt.result) return attempt.result;
      if (!['prepared', 'claimed'].includes(attempt.state))
        throw new GatewayAuthorizationError('EXECUTION_UNKNOWN', 409);
      await setTimeout(Math.min(1000, Math.max(1, options.expiresAt - Date.now())), undefined, {
        signal,
      });
    }
    throw new GatewayAuthorizationError('EXECUTION_UNKNOWN', 409);
  } finally {
    try {
      const attempt = await redisService.gatewayAuthorization.getAttempt(key.attemptId);
      if (attempt && ['prepared', 'claimed'].includes(attempt.state))
        await redisService.gatewayAuthorization.compareAttempt(attempt, {
          ...attempt,
          state: attempt.state === 'claimed' ? 'executionUnknown' : 'cancelledBeforeDispatch',
        });
    } catch (error) {
      console.error(
        'Gateway waiter claim cleanup failed',
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
    settle();
    unbind?.();
    // Cancellation releases local work without waiting for a business callback.
  }
};
