import { parseTenantPath } from '@lobechat/business-tenant/routing';

import {
  isBackendPath,
  resolveTenantRoute,
  type TenantRoute,
} from '@/libs/next/proxy/tenantRouting';

type Entry = {
  slug: string;
  tenantId: string;
  state: { activeUrl: string; endpoints: { kind: string; host: string | null; active: boolean }[] };
};
export interface HostRoutingDeps {
  appUrl: string;
  findHost: (host: string) => Promise<Entry | null>;
  findSlug: (slug: string) => Promise<Entry | null>;
  internalUrl: string;
}
export type HostTenantRoute =
  TenantRoute | { kind: 'redirect'; url: string } | { kind: 'endpoint-changed'; activeUrl: string };

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
  if (internalHost && !defaultHost) {
    if (!parsed.tenantSlug || !INTERNAL_CALLBACKS.test(parsed.rest)) return reject();
    const entry = await deps.findSlug(parsed.tenantSlug);
    return entry ? { kind: 'tenant-backend', slug: entry.slug, path: parsed.rest } : reject();
  }
  if (defaultHost) {
    const route = resolveTenantRoute(url);
    if (route.kind !== 'tenant-page' && route.kind !== 'tenant-backend') return route;
    const entry = await deps.findSlug(route.slug);
    if (!entry) return route.kind === 'tenant-page' ? { kind: 'tenant-required-page' } : reject();
    if (
      entry.state.endpoints.find((e) => e.kind === 'default')?.active ||
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
  if (!entry.state.endpoints.find((e) => e.host === url.hostname.toLowerCase())?.active)
    return changed(url.pathname, entry.state.activeUrl, url.search, method);
  return {
    kind: isBackendPath(url.pathname) ? 'tenant-backend' : 'tenant-page',
    slug: entry.slug,
    path: url.pathname,
  };
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
