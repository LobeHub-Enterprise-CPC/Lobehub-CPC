import { parseTenantPath } from '@lobechat/business-tenant/routing';

/** Memory workflow routes below a tenant prefix: `/orgs/{slug}/api/workflows/memory-user-memory/…`. */
export const MEMORY_WORKFLOW_PATH = '/api/workflows/memory-user-memory/';

/** The app's own origins, as deliveries tell them apart (resolveDeliveryTarget). */
export const appOrigins = (): string[] =>
  [process.env.APP_URL, process.env.INTERNAL_APP_URL, process.env.AGENT_RUNTIME_BASE_URL]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value).origin);

/** The tenant slug of a memory workflow delivery to this app; undefined for any other address. */
export const memoryWorkflowTenantSlug = (url: URL): string | undefined => {
  if (!appOrigins().includes(url.origin)) return undefined;
  const { rest, tenantSlug } = parseTenantPath(url.pathname);
  return tenantSlug && rest.startsWith(MEMORY_WORKFLOW_PATH) ? tenantSlug : undefined;
};
