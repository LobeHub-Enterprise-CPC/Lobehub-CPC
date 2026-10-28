// Named re-exports for the CJS lexer (see `../tenant/index.ts`).
export type { PlatformDatabase } from './db';
export { getPlatformDB } from './db';
export {
  TENANT_DESTROYED_GENERATION,
  tenantDestroyBlocker,
  tenantLeaseBlocker,
} from './processLease';
export {
  tenantDestruction,
  tenantDirectory,
  tenantEndpointEvents,
  tenantEndpoints,
  tenantEndpointState,
  tenantLifecycle,
  tenantLifecycleInbox,
  tenantProvisionOperation,
  tenantRuntimeExternalWork,
  tenantRuntimeProcess,
  tenantSlugAlias,
} from './schemas';
