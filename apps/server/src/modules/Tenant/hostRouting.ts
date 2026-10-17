import { parseTenantPath } from '@lobechat/business-tenant/routing';

import {
  isBackendPath,
  resolveTenantlessRoute,
  resolveTenantRoute,
  type TenantRoute,
} from '@/libs/next/proxy/tenantRouting';
import {
  isNonCanonicalSessionEntryPath,
  isSessionEntryPath,
  SESSION_ENTRY_PATH,
} from '@/server/services/tenantDiscovery/navigation';

type Entry = {
  slug: string;
  tenantId: string;
  state: { activeUrl: string; endpoints: { kind: string; host: string | null; active: boolean }[] };
};
export interface HostRoutingDeps {
  appUrl: string;
  /**
   * Whether the request is a top-level browser document navigation. Only the session entry
   * consults it (anything else answers it with 404); omitted means "not a navigation".
   */
  documentNavigation?: boolean;
  findHost: (host: string) => Promise<Entry | null>;
  findSlug: (slug: string) => Promise<Entry | null>;
  internalUrl: string;
  onDefaultTenantPage?: (entry: Entry) => void;
}
export type HostTenantRoute =
  | TenantRoute
  | { kind: 'redirect'; status?: 308; url: string }
  | { kind: 'endpoint-changed'; activeUrl: string }
  /**
   * The session entry on an active endpoint of a known organization, for a qualified request.
   * `activeUrl` is the organization's trusted public URL; the caller checks the session there.
   * No memory write has been requested for it.
   */
  | { activeUrl: string; kind: 'session-entry'; slug: string }
  /** A redirect that must end with an empty fragment (see `navigationRedirect`). */
  | { kind: 'navigation-redirect'; url: string }
  /**
   * A `/t/{slug}` request for a slug that does not exist. `fallback` is
   * exactly what the same path gets without a tenant; callers serve it and
   * keep `slug` for server logs only (FR-RT-06).
   */
  | { fallback: TenantRoute; kind: 'unknown-tenant'; slug: string };

// Internal transport retains deployment+path addressing; its handlers independently authenticate
// QStash signatures, workflow signatures, API keys or signed callback state. Never admit pages
// or browser auth through a second deployment host.
const INTERNAL_CALLBACKS =
  /^\/(?:api\/workflows(?:\/|$)|trpc\/async(?:\/|$)|webapi\/create-image\/comfyui(?:\/|$)|api\/webhooks\/video(?:\/|$)|api\/agent(?:$|\/(?:run|tool-result|finalize-abandoned|llm-relay|gateway\/(?:callback|desired-connections|start)|webhooks\/(?:bot-callback|bot-replay|subagent-callback|group-member-callback))(?:\/|$)))/;
const ROOT_INTERNAL = /^\/api\/(?:internal\/control-plane|cron)(?:\/|$)/;
const reject = (code = 'NOT_FOUND', status = 404): HostTenantRoute => ({
  kind: 'reject',
  code: code as 'NOT_FOUND',
  status,
});

/** Only the actual request Host is consulted; forwarded-host headers never select a tenant. */
export const resolveHostTenantRoute = async (
  url: URL,
  method: string,
  deps: HostRoutingDeps,
): Promise<HostTenantRoute> => {
  const platform = new URL(deps.appUrl);
  const internal = new URL(deps.internalUrl);
  const defaultHost = url.host.toLowerCase() === platform.host.toLowerCase();
  const internalHost = url.host.toLowerCase() === internal.host.toLowerCase();
  if (ROOT_INTERNAL.test(url.pathname))
    return defaultHost || internalHost ? { kind: 'tenantless-backend' } : reject();
  const parsed = parseTenantPath(url.pathname);
  // Deployment discovery is never a tenant endpoint, including inactive custom authorities
  // and prefixed forms whose slug does not exist. Check before any endpoint redirect.
  if (/^(?:\/t\/[^/]*)?\/api\/tenant-discovery(?:\/|$)/.test(url.pathname))
    return defaultHost && /^\/api\/tenant-discovery(?:\/|$)/.test(url.pathname)
      ? { kind: 'tenantless-backend' }
      : reject();
  if (internalHost && !defaultHost) {
    if (!parsed.tenantSlug || !INTERNAL_CALLBACKS.test(parsed.rest)) return reject();
    const entry = await deps.findSlug(parsed.tenantSlug);
    return entry ? { kind: 'tenant-backend', slug: entry.slug, path: parsed.rest } : reject();
  }
  if (defaultHost) {
    const route = resolveTenantRoute(url);
    if (route.kind !== 'tenant-page' && route.kind !== 'tenant-backend') return route;
    const entry = await deps.findSlug(route.slug);
    if (!entry) {
      const fallback = resolveTenantlessRoute(route.path);
      return {
        fallback:
          fallback.kind === 'tenantless-backend' ? { ...fallback, path: route.path } : fallback,
        kind: 'unknown-tenant',
        slug: route.slug,
      };
    }
    const defaultActive = entry.state.endpoints.find((e) => e.kind === 'default')?.active;
    if (route.kind === 'tenant-page') {
      // The session entry is decided before the visit is remembered and before an endpoint
      // move, so neither can see it.
      const sessionEntry = resolveSessionEntry(
        route.path,
        entry,
        !!defaultActive,
        `${platform.origin}/t/${entry.slug}`,
        deps,
      );
      if (sessionEntry) return sessionEntry;
      deps.onDefaultTenantPage?.(entry);
    }
    if (
      defaultActive ||
      (route.kind === 'tenant-backend' && internalHost && INTERNAL_CALLBACKS.test(route.path))
    )
      return route;
    return changed(route.path, entry.state.activeUrl, url.search, method);
  }
  // A non-default port is another authority, even if the hostname is registered.
  if (url.port && url.port !== '443') return reject();
  const entry = await deps.findHost(url.hostname.toLowerCase());
  if (!entry || /^\/t(?:\/|$)/.test(url.pathname)) return reject();
  if (/^\/api\/(?:internal|cron)(?:\/|$)/.test(url.pathname)) return reject();
  const hostActive = !!entry.state.endpoints.find((e) => e.host === url.hostname.toLowerCase())
    ?.active;
  const sessionEntry = resolveSessionEntry(
    url.pathname,
    entry,
    hostActive,
    `https://${url.hostname.toLowerCase()}`,
    deps,
  );
  if (sessionEntry) return sessionEntry;
  if (!hostActive) return changed(url.pathname, entry.state.activeUrl, url.search, method);
  return {
    kind: isBackendPath(url.pathname) ? 'tenant-backend' : 'tenant-page',
    slug: entry.slug,
    path: url.pathname,
  };
};

/**
 * The session entry (`/__entry` below the organization root). Returns `null` for any other path.
 * Everything here uses only the directory's own URLs: never the request host, query or fragment.
 * - Not a top-level document GET: 404, the same on active and deactivated endpoints.
 * - A deactivated endpoint: to the active endpoint's entry (any spelling), dropping the whole
 *   query and the fragment.
 * - A trailing-slash spelling on an active endpoint: a same-origin permanent redirect to the
 *   canonical entry of this very endpoint, nothing else.
 */
const resolveSessionEntry = (
  path: string,
  entry: Entry,
  endpointActive: boolean,
  /** This request's own, directory-verified origin and base path (`https://host[/t/slug]`). */
  currentBase: string,
  deps: HostRoutingDeps,
): HostTenantRoute | null => {
  const canonical = isSessionEntryPath(path);
  if (!canonical && !isNonCanonicalSessionEntryPath(path)) return null;
  if (!deps.documentNavigation) return reject();
  const activeEntry = `${entry.state.activeUrl}${SESSION_ENTRY_PATH}`;
  // A deactivated endpoint never answers: any spelling goes to the active endpoint's entry.
  if (!endpointActive) return { kind: 'navigation-redirect', url: `${activeEntry}#` };
  if (!canonical)
    return { kind: 'redirect', status: 308, url: `${currentBase}${SESSION_ENTRY_PATH}` };
  return { activeUrl: entry.state.activeUrl, kind: 'session-entry', slug: entry.slug };
};

const changed = (
  path: string,
  activeUrl: string,
  search: string,
  method: string,
): HostTenantRoute => {
  // Protocol callbacks and API/SSE/POST are never cross-domain redirected.
  if (
    !['GET', 'HEAD'].includes(method) ||
    isBackendPath(path) ||
    /^\/(?:oauth|signin|signup|verify-email|reset-password|auth-error|market-auth-callback)(?:\/|$)/.test(
      path,
    )
  )
    return { kind: 'endpoint-changed', activeUrl };
  // Carry only business/navigation parameters. Codes, state, tokens and unknown query fields
  // never leave an inactive authority, even if a provider used an unexpected callback path.
  // When a route adds a query field, opt it in here only if it is navigation/filter data safe
  // to disclose to the tenant's new authority; credentials, personal data and callback state
  // must stay excluded. Add a redirect regression for every new field. Unknown fields are lost
  // on purpose: the user can restart the operation at activeUrl without leaking protocol data.
  const safeSearch = new URLSearchParams();
  const allowed = new Set([
    'hl',
    'tab',
    'page',
    'sort',
    'q',
    'search',
    'agent',
    'topic',
    'session',
    'workspace',
    'utm_source',
    'utm_medium',
    'utm_campaign',
  ]);
  for (const [key, value] of new URLSearchParams(search))
    if (allowed.has(key)) safeSearch.append(key, value);
  const query = safeSearch.size ? `?${safeSearch}` : '';
  return { kind: 'redirect', url: `${activeUrl}${path === '/' ? '' : path}${query}` };
};
