import { type ServerConfigStore } from './store';

export const featureFlagsSelectors = (s: ServerConfigStore) => s.featureFlags;

export const serverConfigSelectors = {
  desktopDownloads: (s: ServerConfigStore) => s.serverConfig.desktopDownloads,
  /** The tenant's connector policy hides the entries for adding custom connectors. */
  disableCustomConnectors: (s: ServerConfigStore) =>
    s.serverConfig.disableCustomConnectors || false,
  disableEmailPassword: (s: ServerConfigStore) => s.serverConfig.disableEmailPassword || false,
  enableBusinessFeatures: (s: ServerConfigStore) => s.serverConfig.enableBusinessFeatures || false,
  enableEmailVerification: (s: ServerConfigStore) =>
    s.serverConfig.enableEmailVerification || false,
  enableComposio: (s: ServerConfigStore) => s.serverConfig.enableComposio || false,
  /** Runtime flag `dashboard`: dashboards, widget previews and the lobe-dashboard tool. */
  enableDashboard: (s: ServerConfigStore) => s.featureFlags.enableDashboard === true,
  enableGatewayMode: (s: ServerConfigStore) => s.serverConfig.enableGatewayMode || false,
  enableLobehubSkill: (s: ServerConfigStore) => s.serverConfig.enableLobehubSkill || false,
  // Private-label deployments run Gateway mode on by default (it's already forced
  // on server-side via ENABLE_BUSINESS_FEATURES) but shouldn't expose the on/off
  // toggle — end users have no way to perceive "Agent Gateway" as a distinct
  // delivery concept. `enableGatewayMode` itself stays untouched: it's still the
  // real capability gate `evaluateGatewayModeEnabled` (helpers/gatewayMode.ts)
  // checks to decide whether a run actually routes through the gateway.
  showGatewayModeToggle: (s: ServerConfigStore) =>
    (s.serverConfig.enableGatewayMode || false) &&
    !(s.serverConfig.enableBusinessFeatures || false),
  enableMagicLink: (s: ServerConfigStore) => s.serverConfig.enableMagicLink || false,
  enableMarketTrustedClient: (s: ServerConfigStore) =>
    s.serverConfig.enableMarketTrustedClient || false,
  enableUploadFileToServer: (s: ServerConfigStore) => s.serverConfig.enableUploadFileToServer,
  /** Workspaces are available to this user (business deployment + per-user `workspace` flag). */
  enableWorkspace: (s: ServerConfigStore) =>
    (s.serverConfig.enableBusinessFeatures || false) && s.featureFlags.enableWorkspace === true,
  enableMultimodalUnderstanding: (s: ServerConfigStore) =>
    s.serverConfig.enableMultimodalUnderstanding || false,
  enabledTelemetryChat: (s: ServerConfigStore) => s.serverConfig.telemetry.langfuse || false,
  isMobile: (s: ServerConfigStore) => s.isMobile || false,
  oAuthSSOProviders: (s: ServerConfigStore) => s.serverConfig.oAuthSSOProviders,
  oidcIssuer: (s: ServerConfigStore) => s.serverConfig.oidcIssuer,
  multimodalUnderstanding: (s: ServerConfigStore) => s.serverConfig.multimodalUnderstanding,
};
