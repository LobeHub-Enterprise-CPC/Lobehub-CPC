import { currentTenantScope, requireTenantScope } from '@lobechat/database/tenant';
import { eq } from 'drizzle-orm';

import { getServerDB } from '@/database/core/db-adaptor';
import { agentOperations } from '@/database/schemas';

import { assertGatewayVersion } from './index';
import type { GatewayExecutionContext } from './types';
import { GatewayAuthorizationError } from './wire';

export const captureOperationGatewayMetadata = (metadata: Record<string, unknown> | undefined) => {
  const scope = currentTenantScope();
  return scope
    ? { ...metadata, tenantId: scope.tenantId, sourceAcceptedVersion: scope.acceptedVersion }
    : metadata;
};
export const loadGatewayOperation = async (operationId: string) => {
  const db = await getServerDB();
  const [row] = await db
    .select()
    .from(agentOperations)
    .where(eq(agentOperations.id, operationId))
    .limit(1);
  if (!row) throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
  if (row.metadata?.tenantId !== requireTenantScope().tenantId)
    throw new GatewayAuthorizationError('RESOURCE_NOT_FOUND', 404);
  return row;
};
export const operationExecutionContext = async (
  operationId: string,
): Promise<GatewayExecutionContext> => {
  const row = await loadGatewayOperation(operationId);
  const version = row.metadata?.sourceAcceptedVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_REQUIRED', 400);
  return { tenantId: requireTenantScope().tenantId, sourceAcceptedVersion: version };
};

export const assertGatewayStateExecution = async (
  operationId: string,
  execution?: GatewayExecutionContext,
) => {
  const scope = currentTenantScope();
  if (!scope) return;
  const original = await operationExecutionContext(operationId);
  if (
    !execution ||
    execution.tenantId !== original.tenantId ||
    execution.sourceAcceptedVersion !== original.sourceAcceptedVersion
  )
    throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_STALE', 409);
  await assertGatewayVersion(original.tenantId, original.sourceAcceptedVersion);
};
export const isGatewayStateExecutionCurrent = async (
  operationId: string,
  execution?: GatewayExecutionContext,
) => {
  try {
    await assertGatewayStateExecution(operationId, execution);
    return true;
  } catch {
    return false;
  }
};

/** Initial state only: resumed state must retain its existing execution envelope. */
export const captureGatewayInitialState = <T extends object>(state: T) => {
  const scope = currentTenantScope();
  return scope
    ? {
        ...state,
        execution: { tenantId: scope.tenantId, sourceAcceptedVersion: scope.acceptedVersion },
      }
    : state;
};
