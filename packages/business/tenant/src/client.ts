import { createStore } from 'zustand/vanilla';

import { parseTenantPath, TENANT_PREFIX, withTenantPath } from './path';
import type { TenantContext } from './resolve';
import { resolveTenant } from './resolve';

interface TenantState {
  tenant: TenantContext | null;
}

// Document-local state: never persist a shared "current tenant" in cookies or localStorage.
const tenantStore = createStore<TenantState>(() => ({ tenant: null }));

/** Called by each browser entry before routing or issuing requests. */
export const initializeTenant = (url: URL, bootstrap?: TenantContext | null): void => {
  tenantStore.setState({ tenant: resolveTenant(url, bootstrap) });
};

export const getTenant = (): TenantContext | null => tenantStore.getState().tenant;

/**
 * Prefix an absolute app path with the current document's tenant.
 *
 * The router basename already does this for in-SPA navigation; a full-page load
 * (`location.href = …`, `window.open`) bypasses it and a bare `/agent` lands on
 * the "use your organization address" page. Without a tenant (desktop, unscoped
 * document) the path is returned unchanged.
 */
export const withCurrentTenantPath = (path: string): string => {
  const tenant = getTenant();
  return tenant?.basePath === '' ? path : withTenantPath(path, tenant?.slug);
};

/**
 * Namespace a `localStorage` key that holds tenant business data (drafts, input
 * history, cached transcripts). Every tenant shares one origin, hence one
 * `localStorage`; an unscoped key would show tenant A's draft to tenant B in the
 * same browser. Pure UI preferences (theme, playback rate) stay unscoped.
 */
export const tenantStorageKey = (key: string): string => {
  const slug = getTenant()?.slug;
  return slug ? `${TENANT_PREFIX}:${slug}:${key}` : key;
};

/**
 * The path below the current document's tenant prefix, or `null` when the path
 * belongs to another tenant (or carries a tenant prefix outside a tenant
 * document). Same-origin URLs of another tenant are not this tenant's resources.
 */
export const currentTenantRelativePath = (pathname: string): string | null => {
  const { rest, tenantSlug } = parseTenantPath(pathname);
  if (getTenant()?.basePath === '') return /^\/t(?:\/|$)/.test(pathname) ? null : pathname;
  return tenantSlug === (getTenant()?.slug ?? null) ? rest : null;
};
