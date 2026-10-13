// Named re-exports for the CJS lexer (see `../tenant/index.ts`).
export type { PlatformDatabase } from './db';
export { getPlatformDB } from './db';
export {
  tenantDirectory,
  tenantEndpointEvents,
  tenantEndpoints,
  tenantEndpointState,
  tenantLifecycle,
  tenantLifecycleInbox,
  tenantProvisionOperation,
  tenantRuntimeClaim,
  tenantRuntimeExternalWork,
  tenantRuntimeProcess,
} from './schemas';
