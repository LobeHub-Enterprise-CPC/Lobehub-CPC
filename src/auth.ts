import { businessAuthPlugins, getBusinessAuthOptions } from '@lobechat/business-auth';
import { requireTenantScope, tenantHash, type TenantScope } from '@lobechat/database/tenant';
import type { BetterAuthOptions } from 'better-auth/minimal';

import { appEnv } from '@/envs/app';
import { defineConfig, tenantAuthBasePath } from '@/libs/better-auth/define-config';
import { buildTenantSsoProviders } from '@/libs/better-auth/tenant-sso';
import {
  loadTenantSsoProviders,
  ssoRevisionKey,
  tenantSsoCallbackPath,
  type TenantSsoProvider,
} from '@/server/services/tenantSso';

/**
 * better-auth per tenant (spec A15, A16, FR-ID-05, FR-ID-09, FR-ID-10).
 *
 * Accounts and sessions live in the tenant schema, so each tenant gets its own
 * better-auth instance: its database, its SSO providers, its endpoints under
 * `/t/{slug}/api/auth`, and cookies named `lh_<h24>_*` scoped to `/t/{slug}`.
 * The instance is resolved from the current tenant scope; outside one, every
 * use fails with `TENANT_REQUIRED`. There is no global auth instance.
 */

type TenantAuth = ReturnType<typeof defineConfig>;

/** Cookie name prefix from the immutable tenant id, not the slug (spec FR-ID-10). */
export const tenantCookiePrefix = (tenantId: string) => `lh_${tenantHash(tenantId)}`;

const SSO_SNAPSHOT_TTL_MS = 30_000;
const MAX_INSTANCES = 64;

const ssoSnapshots = new Map<string, { at: number; providers: TenantSsoProvider[] }>();
const instances = new Map<string, TenantAuth>();

const loadSsoSnapshot = async (scope: TenantScope) => {
  const cached = ssoSnapshots.get(scope.tenantId);
  if (cached && Date.now() - cached.at < SSO_SNAPSHOT_TTL_MS) return cached.providers;
  const providers = await loadTenantSsoProviders(scope.session.database, scope.tenantId);
  ssoSnapshots.set(scope.tenantId, { at: Date.now(), providers });
  return providers;
};

/** Drops a tenant's cached instance and SSO snapshot (lifecycle cache invalidation). */
export const invalidateTenantAuth = (tenantId: string) => {
  ssoSnapshots.delete(tenantId);
  for (const key of instances.keys()) if (key.startsWith(`${tenantId}|`)) instances.delete(key);
};

const tenantSsoProviderSet = (scope: TenantScope, providers: TenantSsoProvider[]) =>
  buildTenantSsoProviders(
    providers,
    (providerId) =>
      `${appEnv.APP_URL.replace(/\/+$/, '')}${tenantSsoCallbackPath(scope.slug, providerId)}`,
  );

/**
 * The tenant's enabled SSO providers that this build can run, and which of
 * them better-auth serves through generic OAuth (the rest are built-in
 * social providers).
 */
export const getTenantSsoProviders = async () => {
  const scope = requireTenantScope();
  const { genericProviderIds, providers } = tenantSsoProviderSet(
    scope,
    await loadSsoSnapshot(scope),
  );
  const generic = new Set(genericProviderIds);
  return providers.map((provider) => ({ ...provider, generic: generic.has(provider.providerId) }));
};

const buildTenantAuth = (
  scope: TenantScope,
  providers: TenantSsoProvider[],
  overrides?: BetterAuthOptions,
) => {
  const { genericOAuthProviders, socialProviders } = tenantSsoProviderSet(scope, providers);
  return defineConfig({
    cookiePrefix: tenantCookiePrefix(scope.tenantId),
    database: scope.session.database,
    genericOAuthProviders,
    overrides,
    plugins: [...businessAuthPlugins],
    secondaryStorageNamespace: `t:${scope.tenantId}`,
    socialProviders,
    tenant: { id: scope.tenantId, slug: scope.slug },
  });
};

export const getTenantAuth = async (): Promise<TenantAuth> => {
  const scope = requireTenantScope();
  const providers = await loadSsoSnapshot(scope);
  const key = `${scope.tenantId}|${scope.slug}|${ssoRevisionKey(providers)}`;

  const cached = instances.get(key);
  if (cached) {
    // Refresh LRU position.
    instances.delete(key);
    instances.set(key, cached);
    return cached;
  }

  const instance = buildTenantAuth(scope, providers);

  for (const existing of instances.keys())
    if (existing.startsWith(`${scope.tenantId}|`)) instances.delete(existing);
  instances.set(key, instance);
  while (instances.size > MAX_INSTANCES) instances.delete(instances.keys().next().value!);
  return instance;
};

export { tenantAuthBasePath };

const apiProxy = new Proxy({} as TenantAuth['api'], {
  get(_target, method) {
    return async (...args: unknown[]) => {
      const instance = await getTenantAuth();
      const fn = Reflect.get(instance.api, method) as (...input: unknown[]) => unknown;
      return fn.apply(instance.api, args);
    };
  },
});

/**
 * The current tenant's better-auth, for callers that use `auth.api.*` or
 * `auth.handler`. Each call resolves the tenant instance at call time.
 */
export const auth = {
  api: apiProxy,
  handler: async (request: Request) => (await getTenantAuth()).handler(request),
} as unknown as TenantAuth;

/**
 * The tenant's better-auth for a protocol request. Session reads use the
 * cached tenant instance; when the distribution contributes request-scoped
 * options (`getBusinessAuthOptions`), a one-off instance of the same tenant
 * carries them.
 */
export const getAuthForRequest = async (request: Request): Promise<TenantAuth> => {
  const overrides = await getBusinessAuthOptions(request);
  if (!overrides) return getTenantAuth();
  const scope = requireTenantScope();
  return buildTenantAuth(scope, await loadSsoSnapshot(scope), overrides);
};
