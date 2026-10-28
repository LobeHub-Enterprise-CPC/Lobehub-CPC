import { hasTenantPrefix } from '@lobechat/business-tenant/routing';
import { runWithTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';

import { getTenantAuth } from '@/auth';
import {
  endpointHosts,
  findHostEndpoint,
  findSlugEndpoint,
} from '@/server/modules/Tenant/endpoints';
import { resolveHostTenantRoute } from '@/server/modules/Tenant/hostRouting';
import { signTenantRoute, TENANT_ROUTE_HEADER } from '@/server/modules/Tenant/routeHeader';
import { routingUnavailableReasonOf } from '@/server/modules/Tenant/routingErrors';
import { getTenantRuntime } from '@/server/modules/Tenant/runtime';
import {
  DESKTOP_FLOW_HEADER,
  isDocumentNavigation,
  redactUrlEmail,
  ROOT_ACCOUNT_HEADER,
  serializeTenantCookie,
  tenantCookieName,
} from '@/server/services/tenantDiscovery/navigation';

import {
  NAVIGATION_REDIRECT_HEADER,
  NAVIGATION_REDIRECT_PATH,
  navigationRedirect,
} from '../navigationRedirect';
import { discoveryNavigation } from './discovery';
import { requestUrlByHost } from './hostAuthority';
import { isDangerousLocalDevProxyRoute, PUBLIC_ACCEPTANCE_GUIDE } from './paths';
import { rejectJson, rewriteTo } from './responses';
import { sessionEntry } from './sessionEntry';
import type { TenantMiddlewareDeps } from './types';

const logTenant = debug('middleware:tenant');

/**
 * Single entry for every matched request (spec A16, A17, FR-RT-04, FR-RT-06):
 * the tenant is read from the URL once, here. Backend requests are rewritten
 * to their unprefixed route with the tenant handed over in a signed header
 * (any incoming copy of that header is dropped first); pages without a
 * tenant follow the discovery navigation policy; tenant pages get the SPA and,
 * when protected, a session check against that tenant's own accounts.
 */
const routeTenantRequest = async (
  deps: TenantMiddlewareDeps,
  req: NextRequest,
  onDefaultTenantPage: (tenantId: string | undefined) => void,
) => {
  logTenant('Processing request: %s %s', req.method, redactUrlEmail(req.url));

  const pathname = req.nextUrl.pathname;
  const headers = new Headers(req.headers);
  headers.delete(TENANT_ROUTE_HEADER);
  headers.delete(DESKTOP_FLOW_HEADER);
  headers.delete(ROOT_ACCOUNT_HEADER);
  headers.delete(NAVIGATION_REDIRECT_HEADER);
  if (isDangerousLocalDevProxyRoute(pathname)) return NextResponse.next({ request: { headers } });

  // Only the proxy's own rewrite may reach the signed-navigation handler. A direct call is
  // refused here, before any tenant lookup, on every authority.
  if (pathname === NAVIGATION_REDIRECT_PATH) return rejectJson('NOT_FOUND', 404);

  // Public installation instructions (a static file) stay readable by coding
  // agents without a tenant; they hold no tenant data.
  if (pathname === PUBLIC_ACCEPTANCE_GUIDE) return NextResponse.next({ request: { headers } });

  let route;
  try {
    const hosts = endpointHosts();
    const requestUrl = requestUrlByHost(req, hosts);
    if (!requestUrl) return rejectJson('NOT_FOUND', 404);
    route = await resolveHostTenantRoute(requestUrl, req.method, {
      ...hosts,
      findHost: findHostEndpoint,
      findSlug: findSlugEndpoint,
      documentNavigation: isDocumentNavigation(req),
      onDefaultTenantPage: (entry) => onDefaultTenantPage(entry.tenantId),
    });
  } catch (error) {
    console.warn('TENANT_ROUTING_UNAVAILABLE', { reason: routingUnavailableReasonOf(error) });
    return rejectJson(
      (error as { code?: string } | null | undefined)?.code === 'ENDPOINTS_NOT_READY'
        ? 'ENDPOINTS_NOT_READY'
        : 'TENANT_UNAVAILABLE',
      503,
    );
  }
  if (route.kind === 'unknown-tenant') {
    // Served exactly like the same request without a tenant (FR-RT-06); the
    // real reason stays in the server log.
    console.warn('TENANT_NOT_FOUND', { slug: route.slug });
    if (route.fallback.kind === 'tenant-discovery-page')
      return discoveryNavigation(deps, req, headers, true);
    route = route.fallback;
  }
  if (route.kind === 'session-entry')
    return sessionEntry(deps, req, headers, route, onDefaultTenantPage);
  if (route.kind === 'navigation-redirect')
    return navigationRedirect(deps, req, headers, route.url);
  if (route.kind === 'redirect')
    return new Response(null, {
      status: route.status ?? 302,
      headers: { 'location': route.url, 'Cache-Control': 'private, no-store' },
    });
  if (route.kind === 'endpoint-changed')
    return Response.json(
      { code: 'TENANT_ENDPOINT_CHANGED', activeUrl: route.activeUrl },
      {
        status: 409,
        headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
      },
    );
  switch (route.kind) {
    case 'reject': {
      return rejectJson(route.code, route.status);
    }
    case 'tenantless-backend': {
      return route.path
        ? rewriteTo(req, route.path, headers)
        : NextResponse.next({ request: { headers } });
    }
    case 'tenant-backend': {
      const signed = signTenantRoute(route.slug);
      if (!signed) return rejectJson('TENANT_NOT_READY', 503);
      headers.set(TENANT_ROUTE_HEADER, signed);
      return rewriteTo(req, route.path, headers);
    }
    case 'tenant-discovery-page': {
      return discoveryNavigation(deps, req, headers, hasTenantPrefix(pathname));
    }
  }

  const signed = signTenantRoute(route.slug);
  if (!signed) return rejectJson('TENANT_NOT_READY', 503);
  headers.set(TENANT_ROUTE_HEADER, signed);

  const tenantPage = new NextRequest(new URL(route.path + req.nextUrl.search, req.url), req);
  const isProtected = !deps.isPublicRoute(tenantPage);
  logTenant(
    'Route protection status: %s, %s',
    redactUrlEmail(req.url),
    isProtected ? 'protected' : 'public',
  );

  let scope;
  let release: () => Promise<void>;
  try {
    ({ scope, release } = await getTenantRuntime().enterSlug(route.slug));
  } catch (error) {
    // An unknown slug looks exactly like no tenant at all: the page never
    // reveals which tenants exist (FR-RT-06). An unavailable tenant still
    // gets its SPA, which shows the tenant-unavailable state from the API.
    if ((error as { code?: string })?.code === 'TENANT_NOT_FOUND') {
      console.warn('TENANT_NOT_FOUND', { slug: route.slug });
      onDefaultTenantPage(undefined);
      headers.delete(TENANT_ROUTE_HEADER);
      return discoveryNavigation(deps, req, headers, true);
    }
    return deps.defaultMiddleware(req, route.path, headers);
  }

  // From here on the scope is held: it is released on every outcome, including a throw.
  try {
    const response = deps.defaultMiddleware(req, route.path, headers);

    // Skip session lookup for public routes to reduce latency
    if (!isProtected) return response;

    // Better Auth may refresh or clear session cookies while reading the session.
    const { response: session, headers: authHeaders } = await runWithTenantScope(scope, async () =>
      (await getTenantAuth()).api.getSession({ headers: req.headers, returnHeaders: true }),
    );
    for (const cookie of authHeaders.getSetCookie()) response.headers.append('set-cookie', cookie);
    const isLoggedIn = !!session?.user;

    logTenant('Session status: %O', { isLoggedIn, userId: session?.user?.id });

    if (!isLoggedIn) {
      logTenant('Request a protected route, redirecting to sign-in page');
      const publicUrl = scope.endpoint!.publicUrl;
      const callbackUrl = `${publicUrl}${route.path === '/' ? '' : route.path}${req.nextUrl.search}`;
      const signInUrl = new URL(`${publicUrl}/signin`);
      signInUrl.searchParams.set('callbackUrl', callbackUrl);
      const hl = req.nextUrl.searchParams.get('hl');
      if (hl) signInUrl.searchParams.set('hl', hl);
      // Preserve marketing attribution so it survives the auth detour.
      const utmSource = req.nextUrl.searchParams.get('utm_source');
      if (utmSource) signInUrl.searchParams.set('utm_source', utmSource);
      const redirectHeaders = new Headers({ location: signInUrl.href });
      for (const cookie of authHeaders.getSetCookie()) redirectHeaders.append('set-cookie', cookie);
      return new Response(null, { headers: redirectHeaders, status: 302 });
    }

    return response;
  } finally {
    await release();
  }
};

/** The proxy's whole tenant layer; `define-config` calls this once. */
export const createTenantMiddleware =
  (deps: TenantMiddlewareDeps) => async (request: NextRequest) => {
    let explicitTenantId: string | undefined;
    const response = await routeTenantRequest(deps, request, (tenantId) => {
      explicitTenantId = tenantId;
    });
    // Apply after every routing/session early return. This preference never enters signed
    // tenant headers or runtime/session admission and is written only on the default host.
    if (explicitTenantId && isDocumentNavigation(request)) {
      const appUrl = endpointHosts().appUrl;
      const previous = request.cookies.get(tenantCookieName(appUrl))?.value;
      if (previous !== explicitTenantId)
        response.headers.append('set-cookie', serializeTenantCookie(explicitTenantId, appUrl));
      response.headers.set('Cache-Control', 'private, no-store');
    }
    const rewrite = response.headers.get('x-middleware-rewrite');
    if (
      response.headers.has('location') ||
      (rewrite && new URL(rewrite).pathname.startsWith('/spa-auth/'))
    ) {
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('Referrer-Policy', 'no-referrer');
    }
    return response;
  };
