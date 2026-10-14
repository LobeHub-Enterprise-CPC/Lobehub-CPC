/** Feature flag values as stored for a tenant: a switch, or the user ids it is on for. */
export type TenantFeatureFlagValues = Record<string, boolean | string[]>;

/** System model choices of a tenant; every model is served by the `lobehub` provider. */
export interface TenantSystemModels {
  /** Embedding model for knowledge base files. */
  fileEmbedding?: string;
  /** Model that reads images and video for models that cannot. Unset: the capability is off. */
  multimodalUnderstanding?: string;
  /** Model per system agent slot; `default` fills the slots left unset. */
  systemAgent?: Record<string, string>;
}

export interface TenantSettings {
  featureFlags: TenantFeatureFlagValues;
  systemModels: TenantSystemModels;
}

/**
 * Settings that vary per tenant in business builds (spec FR-TS-01). Builds
 * without tenant settings return `undefined`, and callers read the deployment
 * environment instead.
 */
export const loadTenantSettings = async (): Promise<TenantSettings | undefined> => undefined;
