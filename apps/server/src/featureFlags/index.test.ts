import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // The env var is read when the config module loads.
  process.env.FEATURE_FLAGS = '-ai_image';

  return {
    loadTenantSettings: vi.fn(),
    publishedFlags: { current: null as string | null },
    tenant: { current: undefined as { tenantId: string } | undefined },
    userOverrides: { current: null as string | null },
  };
});

vi.mock('@lobechat/business-config/tenant-settings', () => ({
  loadTenantSettings: mocks.loadTenantSettings,
}));

vi.mock('@lobechat/database/tenant', () => ({
  currentTenantScope: () => mocks.tenant.current,
  requireTenantScope: () => mocks.tenant.current!,
}));

vi.mock('@/envs/redis', () => ({ getRedisConfig: () => ({ enabled: true }) }));

vi.mock('@/server/modules/Redis', () => ({
  // Deployment-wide published flags live in the shared keyspace, user overrides per tenant.
  initializeRedis: async () => ({ get: async () => mocks.userOverrides.current }),
  initializeSharedRedis: async () => ({ get: async () => mocks.publishedFlags.current }),
}));

const { applyDevelopmentFeatureFlagDefaults, getServerFeatureFlagsFromRuntimeConfig } =
  await import('./index');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('applyDevelopmentFeatureFlagDefaults', () => {
  it('enables Workspace in development when runtime config contains an allowlist', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('FORCE_ENABLE_WORKSPACE_IN_DEV', 'true');

    expect(applyDevelopmentFeatureFlagDefaults({ workspace: ['production-user'] }).workspace).toBe(
      true,
    );
  });

  it('preserves an explicitly configured Workspace flag when the development force-enable is disabled', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('FORCE_ENABLE_WORKSPACE_IN_DEV', 'false');

    expect(
      applyDevelopmentFeatureFlagDefaults(
        { workspace: ['production-user'] },
        {
          workspace: ['production-user'],
        },
      ).workspace,
    ).toEqual(['production-user']);
  });

  it('disables Workspace when the development force-enable is disabled and no runtime config sets it', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('FORCE_ENABLE_WORKSPACE_IN_DEV', 'false');

    // The merged flags carry the isDev schema default (true); opting out must
    // neutralize it so the disabled path is testable locally.
    expect(applyDevelopmentFeatureFlagDefaults({ workspace: true }, {}).workspace).toBe(false);
    expect(applyDevelopmentFeatureFlagDefaults({ workspace: true }).workspace).toBe(false);
  });

  it('preserves the runtime Workspace flag outside development', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(
      applyDevelopmentFeatureFlagDefaults({ workspace: ['production-user'] }).workspace,
    ).toEqual(['production-user']);
  });
});

describe('getServerFeatureFlagsFromRuntimeConfig', () => {
  const tenantFlags: Record<string, Record<string, boolean | string[]>> = {
    'tenant-a': { channel: false, dashboard: true, unknown_flag: true },
    'tenant-b': {},
  };

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    mocks.publishedFlags.current = JSON.stringify({ rag_eval: true });
    mocks.userOverrides.current = null;
  });

  describe('business build', () => {
    beforeEach(() => {
      mocks.loadTenantSettings.mockImplementation(async () => ({
        featureFlags: tenantFlags[mocks.tenant.current!.tenantId],
        systemModels: {},
      }));
    });

    it("reads each tenant's own flags over the schema defaults", async () => {
      mocks.tenant.current = { tenantId: 'tenant-a' };
      const a = await getServerFeatureFlagsFromRuntimeConfig();
      mocks.tenant.current = { tenantId: 'tenant-b' };
      const b = await getServerFeatureFlagsFromRuntimeConfig();

      expect(a).toMatchObject({ channel: false, dashboard: true });
      expect(b).toMatchObject({ channel: true, dashboard: false });
      expect(a).not.toHaveProperty('unknown_flag');
    });

    it('ignores the FEATURE_FLAGS env var and the deployment-wide published flags', async () => {
      mocks.tenant.current = { tenantId: 'tenant-b' };

      expect(await getServerFeatureFlagsFromRuntimeConfig()).toMatchObject({
        ai_image: true,
        rag_eval: false,
      });
    });

    it("keeps a user's override above the tenant flags", async () => {
      mocks.tenant.current = { tenantId: 'tenant-a' };
      mocks.userOverrides.current = JSON.stringify({ channel: true });

      expect(await getServerFeatureFlagsFromRuntimeConfig('user-1')).toMatchObject({
        channel: true,
      });
    });
  });

  describe('upstream build', () => {
    beforeEach(() => {
      mocks.loadTenantSettings.mockResolvedValue(undefined);
      mocks.tenant.current = { tenantId: 'tenant-a' };
    });

    it('falls back to the FEATURE_FLAGS env var when nothing is published', async () => {
      mocks.publishedFlags.current = null;

      expect(await getServerFeatureFlagsFromRuntimeConfig()).toMatchObject({ ai_image: false });
    });
  });
});
