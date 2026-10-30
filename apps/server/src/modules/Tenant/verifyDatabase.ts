import { registerBusinessTenantMigrators } from '@lobechat/business-tenant';
import { registerTenantMigrator, verifyTenantRuntime } from '@lobechat/database/tenant';

registerBusinessTenantMigrators(registerTenantMigrator);

/**
 * Security posture only (role, privileges, schema ownership). Registered distribution chains are
 * consulted for their journal tables, which the runtime role may only read.
 */
export const verifyRuntimeTenantDatabase = verifyTenantRuntime;
