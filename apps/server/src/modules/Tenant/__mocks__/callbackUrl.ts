import { getAppOriginUrl, getInternalApiUrl } from '@/envs/appUrl';

/**
 * Test stand-in for `../callbackUrl`: every callback belongs to the tenant
 * `acme`, so unit tests that do not set up a tenant scope can still assert
 * the tenant address a callback is sent to. Use with
 * `vi.mock('@/server/modules/Tenant/callbackUrl')`.
 */
export const TEST_TENANT_SLUG = 'acme';

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '');

export const tenantCallbackPath = (path: string): string => {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const prefix = `/t/${TEST_TENANT_SLUG}`;
  if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return normalized;
  return normalized === '/' ? prefix : `${prefix}${normalized}`;
};

// Lenient about a missing base (most unit tests leave APP_URL unset).
export const buildTenantCallbackUrl = (
  path: string,
  baseUrl: string = getInternalApiUrl(),
): string => `${trimTrailingSlash(baseUrl ?? '')}${tenantCallbackPath(path)}`;

export const tenantPublicBaseUrl = (): string => buildTenantCallbackUrl('/', getAppOriginUrl());

export const withTenantRequestUrl = (request: Request): Request => request;
