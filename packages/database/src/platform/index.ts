// Named re-exports for the CJS lexer (see `../tenant/index.ts`).
export type { PlatformDatabase } from './db';
export { getPlatformDB } from './db';
export { tenantLeaseBlocker } from './processLease';
export {
  tenantDirectory,
  tenantEndpointEvents,
  tenantEndpoints,
  tenantEndpointState,
  tenantLifecycle,
  tenantLifecycleInbox,
  tenantProvisionOperation,
  tenantRuntimeExternalWork,
  tenantRuntimeProcess,
} from './schemas';
