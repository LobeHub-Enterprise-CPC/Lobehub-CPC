import type { NextRequest, NextResponse } from 'next/server';

import type { Locales } from '@/locales/resources';

/**
 * What the tenant layer needs from the upstream proxy (`../define-config.ts`). It is handed in
 * rather than imported so the upstream file stays the only owner of page rewriting and
 * `define-config` can depend on this folder without a cycle.
 */
export interface TenantMiddlewareDeps {
  /** Upstream page rewrite; `pathname` is the path below `/orgs/{slug}`. */
  defaultMiddleware: (
    request: NextRequest,
    pathname: string,
    routedHeaders?: Headers,
  ) => NextResponse;
  /** Whether a page path is served without a session. */
  isPublicRoute: (request: NextRequest) => boolean;
  /** Allowlists a locale before it is embedded in a rewrite path. */
  toSafeLocale: (locale: string) => Locales;
}
