import {
  getPlatformDB,
  type PlatformDatabase,
  tenantDirectory,
  tenantEndpoints,
} from '@lobechat/database/platform';
import { eq } from 'drizzle-orm';

import { appEnv } from '@/envs/app';
import { TenantEndpointsService } from '@/server/services/tenantControlPlane/endpoints';

export const getTenantEndpoints = () => new TenantEndpointsService(getPlatformDB());
export const loadTenantPublicEndpoint = async (
  tenantId: string,
  platform: PlatformDatabase = getPlatformDB(),
) => {
  const state = await new TenantEndpointsService(platform).get(tenantId);
  const [directory] = await platform
    .select({ slug: tenantDirectory.slug })
    .from(tenantDirectory)
    .where(eq(tenantDirectory.tenantId, tenantId));
  if (!directory) throw new Error('TENANT_NOT_FOUND');
  const url = new URL(state.activeUrl);
  return {
    slug: directory.slug,
    basePath: url.pathname === '/' ? '' : url.pathname,
    publicUrl: state.activeUrl,
    version: state.appliedVersion,
  };
};
export const findHostEndpoint = async (host: string) => {
  const [entry] = await getPlatformDB()
    .select({ tenantId: tenantDirectory.tenantId, slug: tenantDirectory.slug })
    .from(tenantEndpoints)
    .innerJoin(tenantDirectory, eq(tenantDirectory.tenantId, tenantEndpoints.tenantId))
    .where(eq(tenantEndpoints.host, host));
  if (!entry) return null;
  return { ...entry, state: await getTenantEndpoints().get(entry.tenantId) };
};
export const findSlugEndpoint = async (slug: string) => {
  const [entry] = await getPlatformDB()
    .select({ tenantId: tenantDirectory.tenantId, slug: tenantDirectory.slug })
    .from(tenantDirectory)
    .where(eq(tenantDirectory.slug, slug));
  if (!entry) return null;
  return { ...entry, state: await getTenantEndpoints().get(entry.tenantId) };
};
export const endpointHosts = () => ({
  appUrl: appEnv.APP_URL,
  internalUrl: appEnv.INTERNAL_APP_URL || appEnv.APP_URL,
});
