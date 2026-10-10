import { getTenant } from '@lobechat/business-tenant/client';
import { withTenantPath } from '@lobechat/business-tenant/routing';

/**
 * Backend surfaces the request proxy only serves under `/t/{slug}` (spec A16,
 * FR-RT-04). The SPA already runs under the tenant basename; this puts the same
 * prefix on its own backend calls, so services, tRPC, SWR fetchers and the
 * better-auth client keep using plain `/api/...` paths.
 */
const BACKEND_PREFIXES = [
  '/api/',
  '/trpc/',
  '/webapi/',
  '/oidc/',
  '/oauth/connector/',
  '/f/',
  '/market/',
];

const isBackendPath = (pathname: string) =>
  BACKEND_PREFIXES.some((prefix) => pathname.startsWith(prefix) || `${pathname}/` === prefix);

/**
 * The URL to send for `input` from a page of tenant `slug`, or `null` when it
 * must go out unchanged: another origin, a non-backend path, or no tenant.
 */
export const tenantRequestUrl = (
  input: string,
  slug: string | null,
  location: { href: string; origin: string },
): string | null => {
  if (!slug) return null;
  let url: URL;
  try {
    url = new URL(input, location.href);
  } catch {
    return null;
  }
  if (url.origin !== location.origin || !isBackendPath(url.pathname)) return null;

  const pathname = withTenantPath(url.pathname, slug);
  if (pathname === url.pathname) return null;
  url.pathname = pathname;
  // Keep relative inputs relative, so nothing else about the request changes.
  return input.startsWith('/') && !input.startsWith('//')
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
};

const toUrlString = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

/** Prefixes same-origin backend calls made with `fetch`, `XMLHttpRequest` and `EventSource`. */
export const installTenantFetch = (win: Window & typeof globalThis = window) => {
  if (!win.location?.pathname || typeof win.fetch !== 'function') return;
  const tenantSlug = getTenant()?.slug ?? null;
  if (!tenantSlug) return;

  const originalFetch = win.fetch.bind(win);
  win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = tenantRequestUrl(toUrlString(input), tenantSlug, win.location);
    if (!url) return originalFetch(input, init);
    if (typeof input === 'string' || input instanceof URL) return originalFetch(url, init);
    return originalFetch(new Request(url, input), init);
  };

  const XHR = win.XMLHttpRequest;
  if (XHR) {
    const originalOpen = XHR.prototype.open;
    XHR.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: [boolean?, string?, string?]
    ) {
      const prefixed = tenantRequestUrl(url.toString(), tenantSlug, win.location) ?? url;
      return (originalOpen as (...args: unknown[]) => void).call(this, method, prefixed, ...rest);
    } as typeof XHR.prototype.open;
  }

  const OriginalEventSource = win.EventSource;
  if (OriginalEventSource) {
    win.EventSource = class extends OriginalEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(tenantRequestUrl(url.toString(), tenantSlug, win.location) ?? url, init);
      }
    };
  }
};
