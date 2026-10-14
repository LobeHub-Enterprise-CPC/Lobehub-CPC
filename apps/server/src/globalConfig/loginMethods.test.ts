import type { TenantSettings } from '@lobechat/business-config/tenant-settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getLoginMethods } from './loginMethods';

const mocks = vi.hoisted(() => ({
  authEnv: {} as Record<string, boolean>,
  tenantSettings: undefined as TenantSettings | undefined,
}));

vi.mock('@lobechat/business-config/tenant-settings', () => ({
  loadTenantSettings: vi.fn(async () => mocks.tenantSettings),
}));
vi.mock('@/envs/auth', () => ({ authEnv: mocks.authEnv }));

beforeEach(() => {
  mocks.tenantSettings = undefined;
  Object.assign(mocks.authEnv, {
    AUTH_DISABLE_EMAIL_PASSWORD: true,
    AUTH_EMAIL_VERIFICATION: true,
    AUTH_ENABLE_MAGIC_LINK: true,
  });
});

describe('getLoginMethods', () => {
  it('reads the deployment environment in builds without tenant settings', async () => {
    expect(await getLoginMethods()).toEqual({
      emailPassword: false,
      magicLink: true,
      requireEmailVerification: true,
    });
  });

  it("uses the tenant's login methods and ignores the environment", async () => {
    const loginMethods = { emailPassword: true, magicLink: false, requireEmailVerification: false };
    mocks.tenantSettings = { featureFlags: {}, loginMethods, systemModels: {} };

    expect(await getLoginMethods()).toEqual(loginMethods);
  });
});
