import { currentTenantScope } from '@lobechat/database/tenant/requestScope';

interface SpecWithServers {
  servers?: { description?: string; url: string }[];
}

/**
 * The cached spec names the deployment origin, but under a tenant every API
 * path is served below the tenant's public entry (`https://host/orgs/{slug}`,
 * or the root of its custom domain); the origin alone answers
 * `TENANT_REQUIRED`. Point the document's server at that entry so the docs'
 * code samples and "try it" requests reach the tenant. Outside a tenant scope
 * the document is returned unchanged.
 */
export const withTenantServers = <T extends SpecWithServers>(spec: T): T => {
  const publicUrl = currentTenantScope()?.endpoint.publicUrl;
  if (!publicUrl) return spec;
  const [server] = spec.servers ?? [];
  return { ...spec, servers: [{ ...server, url: publicUrl.replace(/\/+$/, '') }] };
};
