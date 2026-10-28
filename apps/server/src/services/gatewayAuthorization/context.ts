import { AsyncLocalStorage } from 'node:async_hooks';

import { requireTenantScope } from '@lobechat/database/tenant';

import type { GatewayAuthorizationSource, GatewayExecutionContext } from './types';
import { GatewayAuthorizationError } from './wire';

const sources = new AsyncLocalStorage<{ source: GatewayAuthorizationSource | undefined }>();
export const runWithGatewaySource = <T>(
  source: GatewayAuthorizationSource | undefined,
  run: () => T,
): T => sources.run({ source }, run);
export const currentGatewaySource = () => sources.getStore()?.source;
export const requireGatewaySource = (subject: string): GatewayAuthorizationSource => {
  const source = currentGatewaySource();
  if (!source || source.subject !== subject)
    throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
  return source;
};
/** Missing request credentials must never be upgraded to internal operation authority. */
export const operationGatewaySource = (
  subject: string,
  operationId: string,
): GatewayAuthorizationSource =>
  sources.getStore() ? requireGatewaySource(subject) : { kind: 'operation', operationId, subject };
export const gatewayExecutionContext = (): GatewayExecutionContext => {
  const scope = requireTenantScope();
  if (!Number.isInteger(scope.acceptedVersion) || scope.acceptedVersion < 1)
    throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_REQUIRED', 400);
  return Object.freeze({ tenantId: scope.tenantId, sourceAcceptedVersion: scope.acceptedVersion });
};
