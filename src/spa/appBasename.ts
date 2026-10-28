import type { TenantContext } from '@lobechat/business-tenant/routing';

export const DEBUG_PROXY_BASE = '/_dangerous_local_dev_proxy';

interface ResolveBasenameInput {
  /** `window.__DEBUG_PROXY__` — forces the proxy base even off-path. */
  debugProxy?: boolean;
  pathname: string;
  tenant: TenantContext | null;
}

export interface ResolvedBasename {
  /** Passed to `createAppRouter` / `matchRoutes`; `undefined` when neither prefix applies. */
  basename?: string;
  /** The tenant the current url addresses, or `null` for an unscoped url. */
  tenantSlug: string | null;
}

/**
 * Resolve the router basename for the current url.
 *
 * The tenant prefix is handled as a **basename**, not as a route segment, for
 * the same reason `/_dangerous_local_dev_proxy` already is: the main-area tree
 * carries a `:workspaceSlug` segment, so any prefix left in the path is eaten as
 * a slug (see `BootShell/routeScope.ts`, which records that exact bug). A
 * basename is stripped before matching, so the entire existing tree — including
 * the workspace subtree — keeps working underneath it with no duplication, and
 * every `<Link to="/agent">` re-emits the prefix automatically.
 *
 * The tradeoff is deliberate: a basename is fixed when the router is created, so
 * switching tenants is a document load rather than a client-side navigation.
 * That is the safer semantic here — it guarantees the store and SWR caches start
 * empty for the new tenant instead of relying on every slice remembering to
 * reset, and a tenant switch is rare and consequential enough to deserve it.
 */
export const resolveAppBasename = ({
  debugProxy,
  pathname,
  tenant,
}: ResolveBasenameInput): ResolvedBasename => {
  const proxyInPath = pathname.startsWith(DEBUG_PROXY_BASE);
  const underProxy = Boolean(debugProxy) || proxyInPath;
  const proxyBase = underProxy ? DEBUG_PROXY_BASE : '';

  const tenantBase = tenant?.basePath ?? '';
  const basename = `${proxyBase}${tenantBase}`;

  return { basename: basename || undefined, tenantSlug: tenant?.slug ?? null };
};
