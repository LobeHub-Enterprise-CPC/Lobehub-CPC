import type { NextRequest } from 'next/server';

import { endpointHosts, getTenantEndpoints } from '@/server/modules/Tenant/endpoints';
import { routingUnavailableReasonOf } from '@/server/modules/Tenant/routingErrors';
import { findAccountOrganizations } from '@/server/services/tenantDiscovery/account';
import {
  accountCookieAvailable,
  accountCookieValue,
  clearAccountCookie,
  readAccountMemory,
} from '@/server/services/tenantDiscovery/accountCookie';
import { selectDesktopTenant } from '@/server/services/tenantDiscovery/desktop';
import { parseDesktopFlow } from '@/server/services/tenantDiscovery/desktopFlow';
import {
  clearTenantCookie,
  isDocumentNavigation,
  isValidTenantId,
  SESSION_ENTRY_PATH,
  tenantCookieName,
} from '@/server/services/tenantDiscovery/navigation';

import { authSpaRoutes } from '../../nextjsOnlyRoutes';
import { isShareSpaRoute } from '../../shareRoutes';
import { navigationRedirect } from '../navigationRedirect';
import { discoveryPage, navigationUnavailable, rejectJson } from './responses';
import type { TenantMiddlewareDeps } from './types';

/** Closed reason codes only: never an email, URL or raw database message. */
const accountFailureReason = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'UNKNOWN';
};

const desktopDiscoveryNavigation = async (
  deps: TenantMiddlewareDeps,
  req: NextRequest,
  headers: Headers,
) => {
  const params = req.nextUrl.searchParams;
  const unambiguous = ['client', 'state', 'code_challenge'].every(
    (key) => params.getAll(key).length === 1,
  );
  const flow = unambiguous
    ? parseDesktopFlow({
        state: params.get('state'),
        codeChallenge: params.get('code_challenge'),
      })
    : null;
  if (!flow) return discoveryPage(deps, req, headers, 'invalid');
  if (params.getAll('switch').includes('1')) return discoveryPage(deps, req, headers, 'ready');
  const tenantId = req.cookies.get(tenantCookieName(endpointHosts().appUrl))?.value;
  if (!tenantId || !isValidTenantId(tenantId)) return discoveryPage(deps, req, headers, 'ready');
  try {
    // The shared service owns select rate limits and its deadline. An existing immutable
    // snapshot is replayed there before any fresh endpoint lookup, including after a move.
    const { url } = await selectDesktopTenant({ headers, flow, tenantId, signal: req.signal });
    return navigationRedirect(deps, req, headers, `${url}#`);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    const status =
      code === 'TENANT_NOT_AVAILABLE'
        ? 'ready'
        : code === 'HANDOFF_EXISTS'
          ? 'expired'
          : 'unavailable';
    console.warn('TENANT_DESKTOP_NAVIGATION_FAILED', { reason: status });
    return discoveryPage(deps, req, headers, status);
  }
};

export const discoveryNavigation = async (
  deps: TenantMiddlewareDeps,
  req: NextRequest,
  headers: Headers,
  explicitTenant = false,
) => {
  // A trailing empty `#` makes the browser drop the fragment it would otherwise inherit.
  const redirect = (path: string) =>
    navigationRedirect(deps, req, headers, `${new URL(endpointHosts().appUrl).origin}${path}`);
  if (!isDocumentNavigation(req))
    return ['GET', 'HEAD'].includes(req.method) && req.nextUrl.pathname === '/'
      ? discoveryPage(deps, req, headers)
      : rejectJson('NOT_FOUND', 404);
  // A bare platform sign-in (the /login rewrite target) without any query re-enters the root
  // decision exactly like `/`: any query (e.g. callbackUrl) keeps the finder page.
  if (
    (req.nextUrl.pathname === '/signin' || req.nextUrl.pathname === '/signin/') &&
    Array.from(req.nextUrl.searchParams.keys()).length === 0
  )
    return redirect('/#');
  if (
    explicitTenant ||
    authSpaRoutes.some(
      (path) => req.nextUrl.pathname === path || req.nextUrl.pathname.startsWith(`${path}/`),
    ) ||
    deps.isPublicRoute(req) ||
    isShareSpaRoute(req.nextUrl.pathname)
  )
    return redirect('/?switch=1#');
  if (req.nextUrl.pathname !== '/') return redirect('/#');
  if (req.nextUrl.searchParams.getAll('client').includes('desktop'))
    return desktopDiscoveryNavigation(deps, req, headers);
  if (req.nextUrl.searchParams.get('switch') === '1') return discoveryPage(deps, req, headers);

  const appUrl = endpointHosts().appUrl;
  const accountValue = accountCookieValue(req.headers, appUrl);
  let clearAccount = false;
  if (accountValue && accountCookieAvailable()) {
    const account = readAccountMemory(accountValue);
    if (!account) clearAccount = true;
    else {
      try {
        // Optional work: it takes a free discovery slot or falls back to today's path at once.
        const organizations = await findAccountOrganizations({
          email: account.email,
          headers: req.headers,
          signal: req.signal,
        });
        if (organizations.length >= 2) return discoveryPage(deps, req, headers, undefined, true);
      } catch (error) {
        // A rate limit or lookup failure never turns into an error page, and the log carries
        // only a reason code: never the remembered email or the cookie.
        console.warn('TENANT_ACCOUNT_MEMORY_UNAVAILABLE', {
          reason: accountFailureReason(error),
        });
      }
    }
  }

  const rememberedNavigation = async () => {
    const remembered = req.cookies.get(tenantCookieName(appUrl))?.value;
    if (!remembered) return discoveryPage(deps, req, headers);
    const clear = () => {
      const response = discoveryPage(deps, req, headers);
      response.headers.append('set-cookie', clearTenantCookie(appUrl));
      return response;
    };
    if (!isValidTenantId(remembered)) return clear();
    try {
      // This service reads PostgreSQL in a fresh transaction, independently of routing caches
      // and lifecycle admission: stopped tenants still have a usable switch-organisation page.
      const state = await getTenantEndpoints().get(remembered);
      // The organization decides whether the browser has a session there (the session entry).
      return navigationRedirect(deps, req, headers, `${state.activeUrl}${SESSION_ENTRY_PATH}#`);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'TENANT_NOT_FOUND') return clear();
      console.warn('TENANT_MEMORY_UNAVAILABLE', { reason: routingUnavailableReasonOf(error) });
      return navigationUnavailable(deps, req);
    }
  };

  const response = await rememberedNavigation();
  if (clearAccount) response.headers.append('set-cookie', clearAccountCookie(appUrl));
  return response;
};
