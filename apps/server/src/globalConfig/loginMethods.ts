import {
  loadTenantSettings,
  type TenantLoginMethods,
} from '@lobechat/business-config/tenant-settings';

import { authEnv } from '@/envs/auth';

export type LoginMethods = TenantLoginMethods;

/**
 * How users sign in: the current tenant's `frontend_login_methods` in business
 * builds (spec FR-TS-07), the `AUTH_*` environment otherwise.
 */
export const getLoginMethods = async (): Promise<LoginMethods> => {
  const tenantSettings = await loadTenantSettings();
  if (tenantSettings) return tenantSettings.loginMethods;

  return {
    emailPassword: !authEnv.AUTH_DISABLE_EMAIL_PASSWORD,
    magicLink: authEnv.AUTH_ENABLE_MAGIC_LINK,
    requireEmailVerification: authEnv.AUTH_EMAIL_VERIFICATION,
  };
};
