export const artifactSharePath = (deploymentId: string) => `/share/artifact/${deploymentId}`;

/**
 * `serverUrl` is the server address, not its origin: a tenant address
 * (`https://host/orgs/acme`) keeps its path prefix, so the share link stays inside
 * the tenant.
 */
export const artifactShareUrl = (serverUrl: string, deploymentId: string) =>
  `${serverUrl.replace(/\/+$/, '')}${artifactSharePath(deploymentId)}`;
