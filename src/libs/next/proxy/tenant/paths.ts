/** Dev-only debug proxy route should bypass all middleware rewrites. */
export const dangerousLocalDevProxyRoute = '/_dangerous_local_dev_proxy';

/** Public installation instructions must remain readable by coding agents, tenant or not. */
export const PUBLIC_ACCEPTANCE_GUIDE = '/acceptance/skill.md';

export const isDangerousLocalDevProxyRoute = (pathname: string) =>
  pathname === dangerousLocalDevProxyRoute ||
  pathname.startsWith(`${dangerousLocalDevProxyRoute}/`);
