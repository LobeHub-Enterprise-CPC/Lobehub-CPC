import { runWithTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import { NextRequest, NextResponse } from 'next/server';
import { UAParser } from 'ua-parser-js';
import urlJoin from 'url-join';

import { getTenantAuth } from '@/auth';
import { LOBE_LOCALE_COOKIE } from '@/const/locale';
import { appEnv } from '@/envs/app';
import { authEnv } from '@/envs/auth';
import { type Locales } from '@/locales/resources';
import { signTenantRoute, TENANT_ROUTE_HEADER } from '@/server/modules/Tenant/routeHeader';
import { getTenantRuntime } from '@/server/modules/Tenant/runtime';
import { parseBrowserLanguage } from '@/utils/locale';
import { DEFAULT_LANG, locales, RouteVariants } from '@/utils/server/routeVariants';

import { authSpaRoutes, nextjsOnlyRoutes } from '../nextjsOnlyRoutes';
import { isShareSpaRoute } from '../shareRoutes';
import { isAlwaysWorkbenchSpaRoute, isWorkbenchSpaRoute } from '../workbenchRoutes';
import { createRouteMatcher } from './createRouteMatcher';
import { resolveTenantRoute, TENANT_REQUIRED_PAGE_PATH } from './tenantRouting';

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
  const defaultMiddleware = (request: NextRequest, pathname: string) => {
    const url = new URL(request.url);
    url.pathname = pathname;
    logDefault('Processing request: %s %s', request.method, request.url);

    // Public installation instructions must remain readable by coding agents.
    if (url.pathname === PUBLIC_ACCEPTANCE_GUIDE) return NextResponse.rewrite(url);

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
        original: url.toString(),
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
      return NextResponse.next();
    }

    const isAuthSpaRoute = authSpaRoutes.some(
      (route) => url.pathname === route || url.pathname.startsWith(`${route}/`),
    );

    // Auth SPA routes: rewrite to /spa-auth/[locale]/[[...path]] catch-all
    if (isAuthSpaRoute) {
      const authSpaPath = `/spa-auth/${safeLocale}${url.pathname}`;
      logDefault('Auth SPA route, rewriting to: %s', authSpaPath);
      url.pathname = authSpaPath;

      const response = NextResponse.rewrite(url);
      persistLocaleCookie(response, request, explicitlyLocale);

      return response;
    }

    // Share pages are responsive on their own, so they get one bundle for every
    // device rather than a mobile variant.
    if (isShareSpaRoute(url.pathname)) {
      const sharePath = `/spa-share/${safeLocale}${url.pathname}`;
      logDefault('Share SPA route, rewriting to: %s', sharePath);
      url.pathname = sharePath;

      const response = NextResponse.rewrite(url);
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

      const response = NextResponse.rewrite(url);
      persistLocaleCookie(response, request, explicitlyLocale);

      return response;
    }

    const isNextjsRoute = nextjsOnlyRoutes.some((r) => url.pathname.startsWith(r));

    // SPA routes: rewrite to /spa/[variants]/[...path] catch-all
    if (!isNextjsRoute) {
      const spaPath = `/spa/${route}${url.pathname === '/' ? '' : url.pathname}`;
      logDefault('SPA route, rewriting to: %s', spaPath);
      url.pathname = spaPath;

      const response = NextResponse.rewrite(url);
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

    logDefault('nextURL after rewrite: %s', url.toString());
    // build rewrite response first
    const rewrite = NextResponse.rewrite(url, { status: 200 });

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
    Response.json({ code }, { headers: { 'Cache-Control': 'private, no-store' }, status });

  const rewriteTo = (request: NextRequest, pathname: string, headers?: Headers) => {
    const url = new URL(request.url);
    url.pathname = pathname;
    return NextResponse.rewrite(url, headers ? { request: { headers } } : undefined);
  };

  /**
   * Single entry for every matched request (spec A16, A17, FR-RT-04, FR-RT-06):
   * the tenant is read from the URL once, here. Backend requests are rewritten
   * to their unprefixed route with the tenant handed over in a signed header
   * (any incoming copy of that header is dropped first); pages without a
   * tenant get the static tenant-required page; tenant pages get the SPA and,
   * when protected, a session check against that tenant's own accounts.
   */
  const betterAuthMiddleware = async (req: NextRequest) => {
    logBetterAuth('BetterAuth middleware processing request: %s %s', req.method, req.url);

    const pathname = req.nextUrl.pathname;
    if (
      pathname === dangerousLocalDevProxyRoute ||
      pathname.startsWith(`${dangerousLocalDevProxyRoute}/`)
    )
      return NextResponse.next();

    // Public installation instructions (a static file) stay readable by coding
    // agents without a tenant; they hold no tenant data.
    if (pathname === PUBLIC_ACCEPTANCE_GUIDE) return NextResponse.next();

    const headers = new Headers(req.headers);
    headers.delete(TENANT_ROUTE_HEADER);

    const route = resolveTenantRoute(req.nextUrl);
    switch (route.kind) {
      case 'reject': {
        return rejectJson(route.code, route.status);
      }
      case 'tenantless-backend': {
        return NextResponse.next({ request: { headers } });
      }
      case 'tenant-backend': {
        const signed = signTenantRoute(route.slug);
        if (!signed) return rejectJson('TENANT_NOT_READY', 503);
        headers.set(TENANT_ROUTE_HEADER, signed);
        return rewriteTo(req, route.path, headers);
      }
      case 'tenant-required-page': {
        return rewriteTo(req, TENANT_REQUIRED_PAGE_PATH);
      }
    }

    const tenantPage = new NextRequest(new URL(route.path + req.nextUrl.search, req.url), req);
    const isProtected = !isPublicRoute(tenantPage);
    logBetterAuth('Route protection status: %s, %s', req.url, isProtected ? 'protected' : 'public');

    let scope;
    try {
      scope = await getTenantRuntime().admitSlug(route.slug);
    } catch (error) {
      // An unknown slug looks exactly like no tenant at all: the page never
      // reveals which tenants exist (FR-RT-06). An unavailable tenant still
      // gets its SPA, which shows the tenant-unavailable state from the API.
      if ((error as { code?: string })?.code === 'TENANT_NOT_FOUND')
        return rewriteTo(req, TENANT_REQUIRED_PAGE_PATH);
      return defaultMiddleware(req, route.path);
    }

    const response = defaultMiddleware(req, route.path);

    // Skip session lookup for public routes to reduce latency
    if (!isProtected) return response;

    // Better Auth may refresh or clear session cookies while reading the session.
    const { response: session, headers: authHeaders } = await runWithTenantScope(scope, async () =>
      (await getTenantAuth()).api.getSession({ headers: req.headers, returnHeaders: true }),
    );
    for (const cookie of authHeaders.getSetCookie()) response.headers.append('set-cookie', cookie);
    const isLoggedIn = !!session?.user;

    logBetterAuth('BetterAuth session status: %O', { isLoggedIn, userId: session?.user?.id });

    if (!isLoggedIn) {
      logBetterAuth('Request a protected route, redirecting to sign-in page');
      const tenantBase = `/t/${route.slug}`;
      const callbackUrl = `${appEnv.APP_URL}${req.nextUrl.pathname}${req.nextUrl.search}`;
      const signInUrl = new URL(`${tenantBase}/signin`, appEnv.APP_URL);
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

  return { middleware: betterAuthMiddleware };
}
