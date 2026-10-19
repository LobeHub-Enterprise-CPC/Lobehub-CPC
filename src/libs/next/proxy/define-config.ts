import { runWithTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import { escapeText } from 'entities';
import { NextRequest, NextResponse } from 'next/server';
import { UAParser } from 'ua-parser-js';
import urlJoin from 'url-join';

import { getTenantAuth } from '@/auth';
import { LOBE_LOCALE_COOKIE } from '@/const/locale';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { translation } from '@/libs/i18n/serverTranslation';
import { type Locales } from '@/locales/resources';
import {
  endpointHosts,
  findHostEndpoint,
  findSlugEndpoint,
  getTenantEndpoints,
} from '@/server/modules/Tenant/endpoints';
import { tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import { resolveHostTenantRoute } from '@/server/modules/Tenant/hostRouting';
import { signTenantRoute, TENANT_ROUTE_HEADER } from '@/server/modules/Tenant/routeHeader';
import { routingUnavailableReasonOf } from '@/server/modules/Tenant/routingErrors';
import { getTenantRuntime } from '@/server/modules/Tenant/runtime';
import { selectDesktopTenant } from '@/server/services/tenantDiscovery/desktop';
import { parseDesktopFlow } from '@/server/services/tenantDiscovery/desktopFlow';
import {
  clearTenantCookie,
  DESKTOP_FLOW_HEADER,
  isDocumentNavigation,
  isValidTenantId,
  lookupEntrySession,
  redactUrlEmail,
  serializeTenantCookie,
  SESSION_ENTRY_PATH,
  tenantCookieName,
} from '@/server/services/tenantDiscovery/navigation';
import type { DesktopFlowStatus } from '@/types/spaServerConfig';
import { parseBrowserLanguage } from '@/utils/locale';
import { DEFAULT_LANG, locales, RouteVariants } from '@/utils/server/routeVariants';

import { authSpaRoutes, nextjsOnlyRoutes } from '../nextjsOnlyRoutes';
import { isShareSpaRoute } from '../shareRoutes';
import { isAlwaysWorkbenchSpaRoute, isWorkbenchSpaRoute } from '../workbenchRoutes';
import { createRouteMatcher } from './createRouteMatcher';
import { navigationRedirect } from './navigationRedirect';

// Create debug logger instances
const PUBLIC_ACCEPTANCE_GUIDE = '/acceptance/skill.md';

const logDefault = debug('middleware:default');
const logBetterAuth = debug('middleware:better-auth');

// Dev-only debug proxy route should bypass all middleware rewrites.
const dangerousLocalDevProxyRoute = '/_dangerous_local_dev_proxy';

// The locale is embedded raw into rewrite paths (/spa-auth/${locale}, /spa/${route}).
// An unvalidated value (e.g. ?hl=../../api/dev) would let the URL parser collapse the
// traversal and rewrite to a confused internal target, so allowlist it before use.
const toSafeLocale = (locale: string): Locales =>
  (locales as readonly string[]).includes(locale) ? (locale as Locales) : DEFAULT_LANG;

const persistLocaleCookie = (
  response: NextResponse,
  request: NextRequest,
  explicitlyLocale: Locales | undefined,
) => {
  if (!explicitlyLocale) return;
  const existingLocale = request.cookies.get(LOBE_LOCALE_COOKIE)?.value as Locales | undefined;
  if (existingLocale) return;
  response.cookies.set(LOBE_LOCALE_COOKIE, explicitlyLocale, {
    // 90 days is a balanced persistence for locale preference
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
};

export function defineConfig() {
  /**
   * Page rewrites for a tenant page. `pathname` is the path below `/t/{slug}`:
   * the SPA reads the tenant prefix from the address bar as its router
   * basename, so the HTML served for `/t/acme/agent` is the one for `/agent`.
   */
  const defaultMiddleware = (request: NextRequest, pathname: string, routedHeaders?: Headers) => {
    const url = new URL(request.url);
    url.pathname = pathname;
    logDefault('Processing request: %s %s', request.method, redactUrlEmail(request.url));

    // Public installation instructions must remain readable by coding agents.
    if (url.pathname === PUBLIC_ACCEPTANCE_GUIDE)
      return NextResponse.rewrite(
        url,
        routedHeaders ? { request: { headers: routedHeaders } } : undefined,
      );

    // locale has three levels
    // 1. search params
    // 2. cookie
    // 3. browser

    // highest priority is explicitly in search params, like ?hl=zh-CN
    const explicitlyLocale = (url.searchParams.get('hl') || undefined) as Locales | undefined;

    // if it's a new user, there's no cookie, So we need to use the fallback language parsed by accept-language
    const browserLanguage = parseBrowserLanguage(request.headers);

    const locale =
      explicitlyLocale ||
      ((request.cookies.get(LOBE_LOCALE_COOKIE)?.value || browserLanguage) as Locales);

    const ua = request.headers.get('user-agent');

    const device = new UAParser(ua || '').getDevice();

    logDefault('User preferences: %O', {
      browserLanguage,
      deviceType: device.type,
      hasCookies: {
        locale: !!request.cookies.get(LOBE_LOCALE_COOKIE)?.value,
      },
      locale,
    });

    const safeLocale = toSafeLocale(locale);

    // 2. Create normalized preference values
    const route = RouteVariants.serializeVariants({
      isMobile: device.type === 'mobile',
      locale: safeLocale,
    });

    logDefault('Serialized route variant: %s', route);

    // if app is in docker, rewrite to self container
    // https://github.com/lobehub/lobe-chat/issues/5876
    if (appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL) {
      logDefault('Local container rewrite enabled: %O', {
        host: '127.0.0.1',
        original: redactUrlEmail(url.toString()),
        port: process.env.PORT || '3210',
        protocol: 'http',
      });

      url.protocol = 'http';
      url.host = '127.0.0.1';
      url.port = process.env.PORT || '3210';
    }

    if (
      url.pathname === dangerousLocalDevProxyRoute ||
      url.pathname.startsWith(`${dangerousLocalDevProxyRoute}/`)
    ) {
      logDefault('Skipping rewrite for dangerous local dev proxy route: %s', url.pathname);
      return NextResponse.next(routedHeaders ? { request: { headers: routedHeaders } } : undefined);
    }

    const isAuthSpaRoute = authSpaRoutes.some(
      (route) => url.pathname === route || url.pathname.startsWith(`${route}/`),
    );

    // Auth SPA routes: rewrite to /spa-auth/[locale]/[[...path]] catch-all
    if (isAuthSpaRoute) {
      const authSpaPath = `/spa-auth/${safeLocale}${url.pathname}`;
      logDefault('Auth SPA route, rewriting to: %s', authSpaPath);
      url.pathname = authSpaPath;

      const response = NextResponse.rewrite(
        url,
        routedHeaders ? { request: { headers: routedHeaders } } : undefined,
      );
      persistLocaleCookie(response, request, explicitlyLocale);

      return response;
    }

    // Share pages are responsive on their own, so they get one bundle for every
    // device rather than a mobile variant.
    if (isShareSpaRoute(url.pathname)) {
      const sharePath = `/spa-share/${safeLocale}${url.pathname}`;
      logDefault('Share SPA route, rewriting to: %s', sharePath);
      url.pathname = sharePath;

      const response = NextResponse.rewrite(
        url,
        routedHeaders ? { request: { headers: routedHeaders } } : undefined,
      );
      persistLocaleCookie(response, request, explicitlyLocale);

      return response;
    }

    if (
      isAlwaysWorkbenchSpaRoute(url.pathname) ||
      (device.type === 'mobile' && isWorkbenchSpaRoute(url.pathname))
    ) {
      const workbenchPath = `/spa-workbench/${safeLocale}${url.pathname}`;
      logDefault('Workbench SPA route, rewriting to: %s', workbenchPath);
      url.pathname = workbenchPath;

      const response = NextResponse.rewrite(
        url,
        routedHeaders ? { request: { headers: routedHeaders } } : undefined,
      );
      persistLocaleCookie(response, request, explicitlyLocale);

      return response;
    }

    const isNextjsRoute = nextjsOnlyRoutes.some((r) => url.pathname.startsWith(r));

    // SPA routes: rewrite to /spa/[variants]/[...path] catch-all
    if (!isNextjsRoute) {
      const spaPath = `/spa/${route}${url.pathname === '/' ? '' : url.pathname}`;
      logDefault('SPA route, rewriting to: %s', spaPath);
      url.pathname = spaPath;

      const response = NextResponse.rewrite(
        url,
        routedHeaders ? { request: { headers: routedHeaders } } : undefined,
      );
      persistLocaleCookie(response, request, explicitlyLocale);

      return response;
    }

    // Next.js App Router routes: rewrite with variants prefix
    const nextPathname = `/${route}` + (url.pathname === '/' ? '' : url.pathname);
    const nextURL = appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL
      ? urlJoin(url.origin, nextPathname)
      : nextPathname;

    logDefault('URL rewrite: %O', {
      isLocalRewrite: appEnv.MIDDLEWARE_REWRITE_THROUGH_LOCAL,
      nextPathname,
      nextURL,
      originalPathname: url.pathname,
    });

    url.pathname = nextPathname;

    logDefault('nextURL after rewrite: %s', redactUrlEmail(url.toString()));
    // build rewrite response first
    const rewrite = NextResponse.rewrite(url, {
      status: 200,
      ...(routedHeaders ? { request: { headers: routedHeaders } } : {}),
    });

    persistLocaleCookie(rewrite, request, explicitlyLocale);

    return rewrite;
  };

  const isPublicRoute = createRouteMatcher([
    // better auth
    '/signin',
    '/signup',
    '/auth-error',
    '/verify-email',
    '/reset-password',
    // oauth
    // Make only the consent view public (GET page), not other oauth paths
    '/oauth/consent/(.*)',
    // market
    '/market-auth-callback',
    // public share pages
    '/share(.*)',
    // standalone verification report viewer — the run id in the URL is the
    // read-only capability for viewing the report without a signed-in session.
    '/verify/(.*)',
    // acceptance decision page — same shape as /verify/:id: the id is the
    // capability; the tRPC layer enforces the aggregate's `visibility` (a
    // private aggregate 404s for anyone but the owner / workspace members).
    '/acceptance/(.*)',
    // messenger verify-im — page itself handles unauth (in-page sign-in CTA)
    // and the random_id token is the actual capability check; no need for
    // session-protected access at the middleware layer.
    '/verify-im',
  ]);

  const rejectJson = (code: string, status: number) =>
    Response.json(
      { code },
      {
        headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
        status,
      },
    );

  const rewriteTo = (request: NextRequest, pathname: string, headers?: Headers) => {
    const url = new URL(request.url);
    url.pathname = pathname;
    return NextResponse.rewrite(url, headers ? { request: { headers } } : undefined);
  };

  /** `retryUrl` must be a trusted, context-free URL; the default retries the platform root. */
  const navigationUnavailable = async (request: NextRequest, retryUrl = '/#') => {
    const locale = toSafeLocale(
      request.nextUrl.searchParams.get('hl') ||
        request.cookies.get(LOBE_LOCALE_COOKIE)?.value ||
        parseBrowserLanguage(request.headers),
    );
    const [{ t }, { t: common }] = await Promise.all([
      translation('auth', locale),
      translation('common', locale),
    ]);
    return new Response(
      `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>503</title></head><body><main><p>${escapeText(t('organization.discovery.unavailable'))}</p><a href="${escapeText(retryUrl)}">${escapeText(common('retry'))}</a></main></body></html>`,
      {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Retry-After': '5',
          'Cache-Control': 'private, no-store',
          'Referrer-Policy': 'no-referrer',
        },
      },
    );
  };

  const discoveryPage = (
    request: NextRequest,
    headers: Headers,
    desktopStatus?: DesktopFlowStatus,
  ) => {
    const locale = toSafeLocale(
      request.nextUrl.searchParams.get('hl') ||
        request.cookies.get(LOBE_LOCALE_COOKIE)?.value ||
        parseBrowserLanguage(request.headers),
    );
    const url = new URL(request.url);
    url.pathname = `/spa-auth/${locale}/`;
    // The root shell must not receive arbitrary authentication/protocol query context.
    url.search = '';
    const routedHeaders = new Headers(headers);
    routedHeaders.delete(DESKTOP_FLOW_HEADER);
    if (desktopStatus) routedHeaders.set(DESKTOP_FLOW_HEADER, desktopStatus);
    return NextResponse.rewrite(url, { request: { headers: routedHeaders } });
  };

  const desktopDiscoveryNavigation = async (req: NextRequest, headers: Headers) => {
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
    if (!flow) return discoveryPage(req, headers, 'invalid');
    if (params.getAll('switch').includes('1')) return discoveryPage(req, headers, 'ready');
    const tenantId = req.cookies.get(tenantCookieName(endpointHosts().appUrl))?.value;
    if (!tenantId || !isValidTenantId(tenantId)) return discoveryPage(req, headers, 'ready');
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
      return discoveryPage(req, headers, status);
    }
  };

  const discoveryNavigation = async (
    req: NextRequest,
    headers: Headers,
    explicitTenant = false,
  ) => {
    // A trailing empty `#` makes the browser drop the fragment it would otherwise inherit.
    const redirect = (path: string) =>
      navigationRedirect(`${new URL(endpointHosts().appUrl).origin}${path}`);
    if (!isDocumentNavigation(req))
      return ['GET', 'HEAD'].includes(req.method) && req.nextUrl.pathname === '/'
        ? discoveryPage(req, headers)
        : rejectJson('NOT_FOUND', 404);
    if (
      explicitTenant ||
      authSpaRoutes.some(
        (path) => req.nextUrl.pathname === path || req.nextUrl.pathname.startsWith(`${path}/`),
      ) ||
      isPublicRoute(req) ||
      isShareSpaRoute(req.nextUrl.pathname)
    )
      return redirect('/?switch=1#');
    if (req.nextUrl.pathname !== '/') return redirect('/#');
    if (req.nextUrl.searchParams.getAll('client').includes('desktop'))
      return desktopDiscoveryNavigation(req, headers);
    if (req.nextUrl.searchParams.get('switch') === '1') return discoveryPage(req, headers);
    const remembered = req.cookies.get(tenantCookieName(endpointHosts().appUrl))?.value;
    if (!remembered) return discoveryPage(req, headers);
    const clear = () => {
      const response = discoveryPage(req, headers);
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
      return navigationUnavailable(req);
    }
  };

  /**
   * The session entry of an active endpoint: asks the remembered organization whether this
   * browser holds a valid session there and answers with a navigation only. Routing has already
   * required a top-level document GET and kept the visit out of the memory cookie. Every target
   * comes from the directory (`activeUrl`) or the platform URL, never from the request.
   *
   * - valid session: the organization root.
   * - no session (missing, expired, revoked): the organization finder; cookies Better Auth
   *   clears for a dead session ride on this response.
   * - the organization refuses admission (frozen, offline, expired, not activated): its root,
   *   whose page explains it. The session is not judged then; there is no scope to read it in.
   * - the organization vanished: the organization finder.
   * - anything else (opening the tenant database, building auth, reading the session): 503
   *   that retries this entry. A failure is never read as "no session".
   */
  const sessionEntry = async (
    req: NextRequest,
    headers: Headers,
    route: { activeUrl: string; slug: string },
    onDefaultTenantPage: (tenantId: string | undefined) => void,
  ) => {
    const root = `${route.activeUrl}/#`;
    const finder = `${new URL(endpointHosts().appUrl).origin}/?switch=1#`;
    const entryUrl = `${route.activeUrl}${SESSION_ENTRY_PATH}`;
    const unavailable = (reason: string) => {
      console.warn('TENANT_SESSION_ENTRY_UNAVAILABLE', { reason });
      return navigationUnavailable(req, `${entryUrl}#`);
    };

    let entered;
    try {
      entered = await getTenantRuntime().enterSlug(route.slug);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'TENANT_NOT_FOUND') {
        console.warn('TENANT_NOT_FOUND', { slug: route.slug });
        onDefaultTenantPage(undefined);
        return navigationRedirect(finder);
      }
      // Only an explicit admission refusal is shown as the organization's own page; a runtime or
      // database failure while opening the scope, or anything unrecognized, is retryable.
      if (tenantGateErrorOf(error)?.source === 'admission') return navigationRedirect(root);
      return unavailable(routingUnavailableReasonOf(error));
    }

    const { release, scope } = entered;
    let lookup;
    try {
      // Persisted state decides (see `lookupEntrySession`): no cookie cache, no refresh, and this
      // instance's own cache cookie hidden because Better Auth decodes it before it honours
      // `disableCookieCache`. The cookie names and attributes come from the tenant's auth
      // instance, never a fixed pattern.
      lookup = await runWithTenantScope(scope, async () =>
        lookupEntrySession(await getTenantAuth(), req.headers),
      );
    } catch {
      return unavailable('SESSION_LOOKUP_FAILED');
    } finally {
      await release().catch(() => console.warn('TENANT_SESSION_ENTRY_RELEASE_FAILED'));
    }

    const response = navigationRedirect(lookup.hasSession ? root : finder);
    for (const cookie of lookup.setCookies) response.headers.append('set-cookie', cookie);
    return response;
  };

  /**
   * Single entry for every matched request (spec A16, A17, FR-RT-04, FR-RT-06):
   * the tenant is read from the URL once, here. Backend requests are rewritten
   * to their unprefixed route with the tenant handed over in a signed header
   * (any incoming copy of that header is dropped first); pages without a
   * tenant follow the discovery navigation policy; tenant pages get the SPA and,
   * when protected, a session check against that tenant's own accounts.
   */
  const betterAuthMiddleware = async (
    req: NextRequest,
    onDefaultTenantPage: (tenantId: string | undefined) => void,
  ) => {
    logBetterAuth(
      'BetterAuth middleware processing request: %s %s',
      req.method,
      redactUrlEmail(req.url),
    );

    const pathname = req.nextUrl.pathname;
    const headers = new Headers(req.headers);
    headers.delete(TENANT_ROUTE_HEADER);
    headers.delete(DESKTOP_FLOW_HEADER);
    if (
      pathname === dangerousLocalDevProxyRoute ||
      pathname.startsWith(`${dangerousLocalDevProxyRoute}/`)
    )
      return NextResponse.next({ request: { headers } });

    // Public installation instructions (a static file) stay readable by coding
    // agents without a tenant; they hold no tenant data.
    if (pathname === PUBLIC_ACCEPTANCE_GUIDE) return NextResponse.next({ request: { headers } });

    let route;
    try {
      const requestUrl = new URL(req.url);
      const hosts = endpointHosts();
      const actualHost = req.headers.get('host');
      if (actualHost) {
        const authority = /^(?:\[[\da-f:.]+\]|[a-z\d.-]+)(?::(\d{1,5}))?$/i.exec(actualHost);
        if (!authority) return rejectJson('NOT_FOUND', 404);
        let parsed: URL;
        try {
          parsed = new URL(`http://${actualHost}`);
        } catch {
          return rejectJson('NOT_FOUND', 404);
        }
        // Next's URL can retain its deployment origin. URL.host assignment does not clear an
        // omitted port and silently ignores malformed ports: validate the entire authority,
        // then assign hostname and port explicitly. Configured public/internal protocols
        // normalize their default ports; custom entries are always HTTPS. Forwarded headers
        // never select an authority or a tenant.
        const origin = [new URL(hosts.appUrl), new URL(hosts.internalUrl)].find(
          (candidate) => candidate.hostname === parsed.hostname,
        );
        requestUrl.protocol = origin?.protocol ?? 'https:';
        requestUrl.hostname = parsed.hostname;
        requestUrl.port = authority[1] === undefined ? '' : String(Number(authority[1]));
      }
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
        return discoveryNavigation(req, headers, true);
      route = route.fallback;
    }
    if (route.kind === 'session-entry')
      return sessionEntry(req, headers, route, onDefaultTenantPage);
    if (route.kind === 'navigation-redirect') return navigationRedirect(route.url);
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
        return discoveryNavigation(req, headers, /^\/t(?:\/|$)/.test(pathname));
      }
    }

    const signed = signTenantRoute(route.slug);
    if (!signed) return rejectJson('TENANT_NOT_READY', 503);
    headers.set(TENANT_ROUTE_HEADER, signed);

    const tenantPage = new NextRequest(new URL(route.path + req.nextUrl.search, req.url), req);
    const isProtected = !isPublicRoute(tenantPage);
    logBetterAuth(
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
        return discoveryNavigation(req, headers, true);
      }
      return defaultMiddleware(req, route.path, headers);
    }

    const response = defaultMiddleware(req, route.path, headers);

    // Skip session lookup for public routes to reduce latency
    if (!isProtected) {
      await release();
      return response;
    }

    // Better Auth may refresh or clear session cookies while reading the session.
    const { response: session, headers: authHeaders } = await runWithTenantScope(scope, async () =>
      (await getTenantAuth()).api.getSession({ headers: req.headers, returnHeaders: true }),
    ).finally(release);
    for (const cookie of authHeaders.getSetCookie()) response.headers.append('set-cookie', cookie);
    const isLoggedIn = !!session?.user;

    logBetterAuth('BetterAuth session status: %O', { isLoggedIn, userId: session?.user?.id });

    if (!isLoggedIn) {
      logBetterAuth('Request a protected route, redirecting to sign-in page');
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
  };

  logDefault('Middleware configuration: %O', { enableOIDC: authEnv.ENABLE_OIDC });

  return {
    middleware: async (request: NextRequest) => {
      let explicitTenantId: string | undefined;
      const response = await betterAuthMiddleware(request, (tenantId) => {
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
    },
  };
}
