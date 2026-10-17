import { randomUUID } from 'node:crypto';

import { requireTenantScope } from '@lobechat/database/tenant';
import { z } from 'zod';

import { gatewayDeviceTarget } from '@/server/services/deviceGateway/access';
import { redisService } from '@/server/services/redis';

import { assertGatewayVersion } from './index';
import { assertGatewaySource } from './sources';
import type {
  GatewayAttemptRecord,
  GatewayAuthorizationSource,
  GatewayCallback,
  GatewayDispatchBinding,
  GatewayExecutionAction,
  GatewayExecutionContext,
  GatewayExecutionIntent,
  GatewayPrincipal,
} from './types';
import { GatewayAuthorizationError, parseGatewayWire, samePrincipal } from './wire';

export const sameBinding = (
  a: GatewayDispatchBinding | undefined,
  b: GatewayDispatchBinding | undefined,
) =>
  !!a &&
  !!b &&
  a.connectionId === b.connectionId &&
  a.connectionGeneration === b.connectionGeneration &&
  a.authorizationId === b.authorizationId;

export const createGatewayAttempt = async (
  input: GatewayExecutionContext & {
    source: GatewayAuthorizationSource;
    targetPrincipal: GatewayPrincipal;
    action: GatewayExecutionAction;
    operationId?: string;
    toolCallId?: string;
    resourceId: string;
    attemptExpiresAt: number;
  },
): Promise<GatewayExecutionIntent> => {
  if (input.tenantId !== requireTenantScope().tenantId)
    throw new GatewayAuthorizationError('TENANT_MISMATCH', 403);
  await assertGatewayVersion(input.tenantId, input.sourceAcceptedVersion);
  const expiresAt = await assertGatewaySource(input.source, {
    principal: input.targetPrincipal,
    operationId: input.operationId,
    execute: true,
  });
  if (input.action.startsWith('device.'))
    await gatewayDeviceTarget(input.source.subject, input.targetPrincipal, input.resourceId);
  const now = Date.now();
  if (input.attemptExpiresAt <= now || input.attemptExpiresAt > now + 600_000 || expiresAt <= now)
    throw new GatewayAuthorizationError('LEASE_EXPIRED');
  const intent: GatewayExecutionIntent = {
    tenancyProtocol: 1,
    tenantId: input.tenantId,
    sourceAcceptedVersion: input.sourceAcceptedVersion,
    actor: { subject: input.source.subject, sourceRef: randomUUID() },
    targetPrincipal: input.targetPrincipal,
    action: input.action,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    resourceId: input.resourceId,
    attemptId: randomUUID(),
    attemptExpiresAt: input.attemptExpiresAt,
  };
  parseGatewayWire('executionIntent', intent);
  await redisService.gatewayAuthorization.putAttempt({
    intent,
    source: input.source,
    state: 'prepared',
  });
  return intent;
};

export const loadGatewayAttempt = async (
  attemptId: string,
  context: GatewayExecutionContext,
  binding: GatewayDispatchBinding,
  operationId?: string,
) => {
  const record = await redisService.gatewayAuthorization.getAttempt(attemptId);
  if (!record || record.intent.attemptExpiresAt <= Date.now())
    throw new GatewayAuthorizationError('EXECUTION_UNKNOWN', 409);
  if (
    record.intent.tenantId !== context.tenantId ||
    record.intent.sourceAcceptedVersion !== context.sourceAcceptedVersion ||
    (operationId && record.intent.operationId !== operationId)
  )
    throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  await assertGatewayVersion(context.tenantId, context.sourceAcceptedVersion);
  await assertGatewaySource(record.source, {
    principal: record.intent.targetPrincipal,
    operationId: record.intent.operationId,
    execute: true,
  });
  if (record.intent.action.startsWith('device.'))
    await gatewayDeviceTarget(
      record.source.subject,
      record.intent.targetPrincipal,
      record.intent.resourceId,
    );
  const target = await redisService.gatewayAuthorization.getAuthorization(binding.authorizationId);
  if (
    !target ||
    Math.min(target.ticketExpiresAt, target.authRecordExpiresAt) <= Date.now() ||
    !samePrincipal(target.principal, record.intent.targetPrincipal) ||
    target.acceptedVersion !== context.sourceAcceptedVersion
  )
    throw new GatewayAuthorizationError('UNAUTHORIZED');
  const audience = record.intent.action.startsWith('device.')
    ? 'urn:lobehub:gateway:device'
    : 'urn:lobehub:gateway:agent';
  if (
    target.audience !== audience ||
    (audience.endsWith(':agent') && target.operationId !== record.intent.operationId)
  )
    throw new GatewayAuthorizationError('UNAUTHORIZED');
  await assertGatewaySource(target.source, {
    principal: target.principal,
    operationId: target.operationId,
    enroller: target.audience === 'urn:lobehub:gateway:device',
    execute: true,
  });
  return record;
};

export const claimGatewayAttempt = async (
  record: GatewayAttemptRecord,
  binding: GatewayDispatchBinding,
) => {
  if (record.state !== 'prepared') throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  if (
    !(await redisService.gatewayAuthorization.compareAttempt(record, {
      ...record,
      state: 'claimed',
      dispatchBinding: binding,
    }))
  )
    throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
};
const toolResultSchema = z.object({
  content: z.string().nullable(),
  success: z.boolean(),
  toolCallId: z.string().optional(),
  error: z.object({ message: z.string(), type: z.string().optional() }).optional(),
  executionTimeMs: z.number().nonnegative().optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  workRegistration: z.unknown().optional(),
});
export const acceptGatewayCallback = async (input: GatewayCallback) => {
  if (input.outcome === 'completed') {
    const result = toolResultSchema.safeParse(input.result);
    if (!result.success || (result.data.toolCallId && result.data.toolCallId !== input.toolCallId))
      throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  }
  const record = await loadGatewayAttempt(
    input.attemptId,
    input,
    input.dispatchBinding,
    input.operationId,
  );
  if (
    record.intent.toolCallId !== input.toolCallId ||
    !sameBinding(record.dispatchBinding, input.dispatchBinding)
  )
    throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  if (record.state !== 'claimed') throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  if (
    !(await redisService.gatewayAuthorization.compareAttempt(record, {
      ...record,
      state: input.outcome,
      result: input,
    }))
  )
    throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
  return {
    tenantId: input.tenantId,
    sourceAcceptedVersion: input.sourceAcceptedVersion,
    operationId: input.operationId,
    attemptId: input.attemptId,
    outcome: input.outcome,
  };
};
