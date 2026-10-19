import { registerBusinessTenantMigrators } from '@lobechat/business-tenant';
import { registerTenantMigrator, verifyTenantRuntime } from '@lobechat/database/tenant';

registerBusinessTenantMigrators(registerTenantMigrator);

/** Uses the same registered distribution chains as provisioning. */
export const verifyRuntimeTenantDatabase = verifyTenantRuntime;
