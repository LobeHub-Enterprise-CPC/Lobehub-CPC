import { loadTenantSettings } from '@lobechat/business-config/tenant-settings';
import createDebug from 'debug';
import { z } from 'zod';

import type { IFeatureFlags } from '@/config/featureFlags';
import {
  DEFAULT_FEATURE_FLAGS,
  FeatureFlagsSchema,
  getExplicitServerFeatureFlags,
  mapFeatureFlagsEnvToState,
} from '@/config/featureFlags';
import type {
  RuntimeConfigDomain,
  RuntimeConfigProvider,
  RuntimeConfigSelector,
} from '@/server/runtimeConfig';
import {
  CompositeRuntimeConfigProvider,
  EnvRuntimeConfigProvider,
  RedisRuntimeConfigProvider,
} from '@/server/runtimeConfig';
import { merge } from '@/utils/merge';

const debug = createDebug('lobe:featureFlags');

const FEATURE_FLAGS_DOMAIN: RuntimeConfigDomain<IFeatureFlags> = {
  cacheTtlMs: 5000,
  getStorageKey: () => 'runtime-config:feature-flags:published',
  getVersionKey: () => 'runtime-config:feature-flags:version',
  key: 'feature-flags',
  schema: FeatureFlagsSchema,
  // Published flags are one set per deployment; user overrides are per tenant.
  shared: true,
};

const FEATURE_FLAG_OVERRIDE_DOMAIN: RuntimeConfigDomain<Record<string, boolean>> = {
  cacheNullSnapshots: false,
  cacheTtlMs: 30_000,
  getStorageKey: (selector?: RuntimeConfigSelector) => {
    if (!selector || selector.scope !== 'user')
      return 'runtime-config:feature-flags:user:anonymous';

    return `runtime-config:feature-flags:user:${selector.id}`;
  },
  key: 'feature-flags-user-overrides',
  schema: z.record(z.string(), z.boolean()),
};

let featureFlagsProvider: RuntimeConfigProvider<IFeatureFlags> | null = null;
let featureFlagsOverrideProvider: RuntimeConfigProvider<Record<string, boolean>> | null = null;

export const applyDevelopmentFeatureFlagDefaults = (
  flags: IFeatureFlags,
  snapshot?: Partial<IFeatureFlags>,
) => {
  if (process.env.NODE_ENV !== 'development') return flags;

  if (process.env.FORCE_ENABLE_WORKSPACE_IN_DEV === 'false') {
    // Opting out must also neutralize the isDev schema default, otherwise the
    // disabled path is untestable locally; an explicit value from the shared
    // runtime config still wins.
    return snapshot && 'workspace' in snapshot ? flags : { ...flags, workspace: false };
  }

  return { ...flags, workspace: true };
};

const getFeatureFlagsProvider = () => {
  featureFlagsProvider ??= new CompositeRuntimeConfigProvider(
    new RedisRuntimeConfigProvider(FEATURE_FLAGS_DOMAIN),
    // Expose only explicitly-configured env flags; schema defaults are merged in
    // getMergedFeatureFlags, so the snapshot stays distinguishable from defaults.
    new EnvRuntimeConfigProvider(FEATURE_FLAGS_DOMAIN, {
      getSnapshotData: () => getExplicitServerFeatureFlags(),
    }),
  );

  return featureFlagsProvider;
};

const getFeatureFlagOverrideProvider = () => {
  featureFlagsOverrideProvider ??= new RedisRuntimeConfigProvider(FEATURE_FLAG_OVERRIDE_DOMAIN);

  return featureFlagsOverrideProvider;
};

/**
 * The explicitly-configured global flags, without schema defaults. Business
 * builds use the current tenant's `feature_flags` only (spec FR-TS-02): neither
 * the FEATURE_FLAGS env var nor the deployment-wide published snapshot applies.
 */
const getGlobalFeatureFlagsData = async (): Promise<Partial<IFeatureFlags> | undefined> => {
  const tenantSettings = await loadTenantSettings();
  // Unknown flags are dropped by the schema.
  if (tenantSettings) return FeatureFlagsSchema.parse(tenantSettings.featureFlags);

  const globalSnapshot = await getFeatureFlagsProvider().getSnapshot({ scope: 'global' });

  return globalSnapshot?.data;
};

const getMergedFeatureFlags = async (userId?: string) => {
  const globalData = await getGlobalFeatureFlagsData();

  // Shared runtime config can contain production allowlists even in local development.
  // Apply development defaults after the global snapshot; user-specific overrides below still win.
  const globalFlags = applyDevelopmentFeatureFlagDefaults(
    merge(DEFAULT_FEATURE_FLAGS, globalData || {}),
    globalData,
  );

  if (!userId) {
    return globalFlags;
  }

  const userOverrideSnapshot = await getFeatureFlagOverrideProvider().getSnapshot({
    id: userId,
    scope: 'user',
  });

  if (!userOverrideSnapshot) {
    return globalFlags;
  }

  return merge(globalFlags, userOverrideSnapshot.data as Partial<IFeatureFlags>);
};

/**
 * Get feature flags from RuntimeConfig with fallback to environment variables; business
 * builds read the current tenant's settings instead
 * @param userId - Optional user ID for user-specific feature flag evaluation
 */
export const getServerFeatureFlagsFromRuntimeConfig = async (userId?: string) => {
  const flags = await getMergedFeatureFlags(userId);

  debug('Using runtime feature flags for user: %s', userId || 'anonymous');

  return flags;
};

/**
 * Get server feature flags from RuntimeConfig and map them to state with user ID
 * @param userId - Optional user ID for user-specific feature flag evaluation
 */
export const getServerFeatureFlagsStateFromRuntimeConfig = async (userId?: string) => {
  const flags = await getServerFeatureFlagsFromRuntimeConfig(userId);
  return mapFeatureFlagsEnvToState(flags, userId);
};
