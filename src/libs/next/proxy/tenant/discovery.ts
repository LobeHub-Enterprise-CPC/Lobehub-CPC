import type { NextRequest } from 'next/server';

import { endpointHosts, getTenantEndpoints } from '@/server/modules/Tenant/endpoints';
import { routingUnavailableReasonOf } from '@/server/modules/Tenant/routingErrors';
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
    return navigationRedirect(`${url}#`);
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
    navigationRedirect(`${new URL(endpointHosts().appUrl).origin}${path}`);
  if (!isDocumentNavigation(req))
    return ['GET', 'HEAD'].includes(req.method) && req.nextUrl.pathname === '/'
      ? discoveryPage(deps, req, headers)
      : rejectJson('NOT_FOUND', 404);
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
  const remembered = req.cookies.get(tenantCookieName(endpointHosts().appUrl))?.value;
  if (!remembered) return discoveryPage(deps, req, headers);
  const clear = () => {
    const response = discoveryPage(deps, req, headers);
    response.headers.append('set-cookie', clearTenantCookie(endpointHosts().appUrl));
    return response;
  };
  if (!isValidTenantId(remembered)) return clear();
  try {
    // This service reads PostgreSQL in a fresh transaction, independently of routing caches
    // and lifecycle admission: stopped tenants still have a usable switch-organisation page.
    const state = await getTenantEndpoints().get(remembered);
    // The organization decides whether the browser has a session there (the session entry).
    return navigationRedirect(`${state.activeUrl}${SESSION_ENTRY_PATH}#`);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'TENANT_NOT_FOUND') return clear();
    console.warn('TENANT_MEMORY_UNAVAILABLE', { reason: routingUnavailableReasonOf(error) });
    return navigationUnavailable(deps, req);
  }
};
