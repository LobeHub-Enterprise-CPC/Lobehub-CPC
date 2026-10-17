import {
  getPlatformDB,
  type PlatformDatabase,
  tenantDirectory,
  tenantEndpoints,
} from '@lobechat/database/platform';
import { eq } from 'drizzle-orm';

import { appEnv } from '@/envs/app';
import { TenantEndpointsService } from '@/server/services/tenantControlPlane/endpoints';

import { EndpointRoutingCache } from './endpointCache';
import { TenantGateError } from './errors';

export const getTenantEndpoints = () => new TenantEndpointsService(getPlatformDB());
type EndpointEntry = {
  /** The organization's display name in the platform directory. */
  name: string;
  routingFetchedAt: number;
  slug: string;
  tenantId: string;
  state: Awaited<ReturnType<TenantEndpointsService['get']>>;
};
const repositories = new WeakMap<PlatformDatabase, EndpointRoutingCache<EndpointEntry>>();
const repository = (platform: PlatformDatabase) => {
  let cache = repositories.get(platform);
  if (!cache) {
    cache = new EndpointRoutingCache(
      async (key) => {
        const routingFetchedAt = performance.now();
        const separator = key.indexOf(':');
        const kind = key.slice(0, separator);
        const value = key.slice(separator + 1);
        const columns = {
          name: tenantDirectory.name,
          slug: tenantDirectory.slug,
          tenantId: tenantDirectory.tenantId,
        };
        const [entry] =
          kind === 'host'
            ? await platform
                .select(columns)
                .from(tenantEndpoints)
                .innerJoin(tenantDirectory, eq(tenantDirectory.tenantId, tenantEndpoints.tenantId))
                .where(eq(tenantEndpoints.host, value))
            : await platform
                .select(columns)
                .from(tenantDirectory)
                .where(
                  kind === 'slug'
                    ? eq(tenantDirectory.slug, value)
                    : eq(tenantDirectory.tenantId, value),
                );
        if (!entry) return null;
        // Each key reads a fresh snapshot; never wrap an older tenant-key cache entry and
        // accidentally extend its TTL while resolving a slug or authority.
        return {
          ...entry,
          routingFetchedAt,
          state: await new TenantEndpointsService(platform).get(entry.tenantId),
        };
      },
      undefined,
      (entry) => entry.routingFetchedAt,
    );
    repositories.set(platform, cache);
  }
  return cache;
};
export const loadTenantPublicEndpoint = async (
  tenantId: string,
  platform: PlatformDatabase = getPlatformDB(),
) => {
  const entry = await repository(platform).get(`tenant:${tenantId}`);
  if (!entry) throw new TenantGateError('TENANT_NOT_FOUND');
  const url = new URL(entry.state.activeUrl);
  return {
    slug: entry.slug,
    basePath: url.pathname === '/' ? '' : url.pathname,
    publicUrl: entry.state.activeUrl,
    version: entry.state.appliedVersion,
  };
};
export const findHostEndpoint = (host: string, platform: PlatformDatabase = getPlatformDB()) =>
  repository(platform).get(`host:${host}`);
export const findSlugEndpoint = (slug: string, platform: PlatformDatabase = getPlatformDB()) =>
  repository(platform).get(`slug:${slug}`);
export const endpointHosts = () => ({
  appUrl: appEnv.APP_URL,
  internalUrl: appEnv.INTERNAL_APP_URL || appEnv.APP_URL,
});
