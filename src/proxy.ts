import { defineConfig } from '@/libs/next/proxy/define-config';

const { middleware } = defineConfig();

// required to be literal
export const config = {
  matcher: [
    // Backend surfaces ARE matched (spec A16, FR-RT-04): the proxy is the one
    // place that reads the tenant from the URL. It rewrites `/t/{slug}/api/...`
    // to `/api/...` with a signed tenant header, drops any client-sent copy of
    // that header, and refuses tenantless business requests with
    // `TENANT_REQUIRED` before they reach a route handler.
    '/api/:path*',
    '/trpc/:path*',
    '/webapi/:path*',
    '/f/:path*',
    '/market/:path*',
    // include the /
    '/',
    '/acceptance',
    '/acceptance(.*)',
    '/channels',
    '/channels(.*)',
    '/apps',
    '/apps(.*)',
    '/community',
    '/community(.*)',
    '/labs',
    '/eval',
    '/eval(.*)',
    /** Shared-agent pages need the same SPA rewrite as the other client routes. */
    '/a',
    '/a/(.*)',
    '/agent',
    '/agent(.*)',
    '/group',
    '/group(.*)',
    '/changelog(.*)',
    '/settings(.*)',
    '/image',
    '/video',
    // Registered in the SPA router but missing here, so it 404'd: a path absent
    // from this list never reaches the middleware, is never rewritten to
    // `/spa/<variant>/…`, and App Router has no page of that name to fall back
    // on. The list has to be a literal (Next requirement, see above), so it
    // cannot be derived from the router — adding a top-level route means adding
    // it in both places.
    '/downloads',
    '/resource',
    '/resource(.*)',
    '/profile(.*)',
    '/page',
    '/page(.*)',
    '/tasks',
    '/tasks(.*)',
    '/task',
    '/task(.*)',
    '/goals',
    '/goals(.*)',
    '/goal',
    '/goal(.*)',
    '/me',
    '/me(.*)',
    '/share(.*)',

    '/onboarding',
    '/onboarding(.*)',

    '/signup(.*)',
    '/signin(.*)',
    '/verify-email(.*)',
    '/verify-im(.*)',
    '/verify',
    '/verify/(.*)',
    '/reset-password(.*)',
    '/auth-error(.*)',
    '/oauth(.*)',
    '/oidc(.*)',
    '/market-auth-callback(.*)',

    // Tenant-scoped mirrors of every client route above: `/t/{slug}/...`.
    //
    // One entry covers the whole subtree because the tenant prefix is handled as
    // a router BASENAME (src/spa/appBasename.ts), not as a route segment — the
    // SPA strips `/t/{slug}` before matching, so the paths underneath are the
    // same ones already listed. Without this entry the middleware never runs for
    // a tenant url, the rewrite to `/spa/<variant>/...` never happens, and App
    // Router 404s on a path it has no page for.
    //
    // Backend paths under a tenant are covered by the same two entries.
    '/t/:slug',
    '/t/:slug/(.*)',
  ],
};

export default middleware;
