// Named re-exports for the CJS lexer (see `../tenant/index.ts`).
export type { PlatformDatabase } from './db';
export { getPlatformDB } from './db';
export {
  tenantDirectory,
  tenantLifecycle,
  tenantLifecycleInbox,
  tenantProvisionOperation,
} from './schemas';
