import {
  buildRemoteUrl,
  normalizeRemoteBaseUrl,
  relativeToRemoteBase,
  resolveRemoteUrl,
} from '@lobechat/utils/remoteUrl';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { parseTenantPath, TENANT_PREFIX, withTenantPath } from './path';
import type { TenantContext } from './resolve';
import { resolveTenant } from './resolve';

interface TenantState {
  /**
   * The remote server address of a client the app server does not serve (the
   * desktop renderer); `undefined` for a page the server served itself, `''`
   * while the remote address is not configured yet.
   */
  remoteAddress: string | undefined;
  tenant: TenantContext | null;
}

// Document-local state: never persist a shared "current tenant" in cookies or localStorage.
const tenantStore = createStore<TenantState>(() => ({ remoteAddress: undefined, tenant: null }));

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

// ---------------------------------------------------------------------------
// App address: where this tenant's app lives, for every absolute link the
// client builds (copied/shared links, OAuth redirect URIs, downloads, assets).
// ---------------------------------------------------------------------------

/**
 * Called by a client that is not served by the app server (the desktop
 * renderer) with its configured remote server address, a tenant address such
 * as `https://host/t/acme`; `''` while unconfigured, `undefined` to unset.
 */
export const setRemoteAppAddress = (address: string | undefined): void => {
  const remoteAddress = address === undefined ? undefined : normalizeRemoteBaseUrl(address);
  if (tenantStore.getState().remoteAddress !== remoteAddress)
    tenantStore.setState({ remoteAddress });
};

const appBaseUrlOf = ({ remoteAddress, tenant }: TenantState): string => {
  if (remoteAddress !== undefined) return remoteAddress;
  if (tenant?.publicUrl) return normalizeRemoteBaseUrl(tenant.publicUrl);
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${tenant?.basePath ?? ''}`;
};

/**
 * The address the tenant's app lives under, without a trailing slash:
 * - a page the server served: the tenant's active public address it
 *   bootstrapped (`https://host/t/acme`, or a custom domain); without a
 *   bootstrap, the page origin plus the tenant path it was addressed with;
 * - the desktop renderer: the configured remote server address (`''` until set).
 *
 * Append app paths to it (`${getAppBaseUrl()}/agent/...`) or use the helpers
 * below; `new URL(path, base)` drops the tenant path.
 */
export const getAppBaseUrl = (): string => appBaseUrlOf(tenantStore.getState());

/** React binding of {@link getAppBaseUrl}; follows the remote address as it is configured. */
export const useAppBaseUrl = (): string => useStore(tenantStore, appBaseUrlOf);

/** Absolute URL of an app page (path, query allowed) under the app address. */
export const buildAppUrl = (path: string): string =>
  buildRemoteUrl(path, getAppBaseUrl()).toString();

/**
 * A server-returned URL (uploaded file, avatar, banner) that may be a
 * server-relative path, made absolute under the app address. Absolute,
 * protocol-relative, `data:` and `blob:` values are returned as they are.
 */
export const resolveAppUrl = (value: string): string => resolveRemoteUrl(value, getAppBaseUrl());

/**
 * The app path of a URL pathname under the app address (`/t/acme/f/x` ->
 * `/f/x`), or `null` when it belongs to another tenant or no address is known.
 */
export const appRelativePath = (pathname: string): string | null => {
  const base = getAppBaseUrl();
  if (!base) return null;
  try {
    return relativeToRemoteBase(pathname, base);
  } catch {
    return null;
  }
};

export { installTenantAssets, resolveTenantAssetUrl } from './assets';
export { installTenantFetch, tenantRequestUrl } from './fetch';
