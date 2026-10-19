import { getTenant } from './client';
import { stripTenantPath, withTenantPath } from './path';
import { isBackendPath } from './routing';

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

const isSameOriginBackendCall = (input: string, location: { href: string; origin: string }) => {
  try {
    const url = new URL(input, location.href);
    return url.origin === location.origin && isBackendPath(stripTenantPath(url.pathname));
  } catch {
    return false;
  }
};

const toUrlString = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

const ENDPOINT_CHANGED = 'TENANT_ENDPOINT_CHANGED';
const ENDPOINT_CHANGED_GUARD_KEY = 'lobe:tenant-endpoint-changed';
/** One re-resolution per window; a root that still answers 409 must not turn into a reload loop. */
const ENDPOINT_CHANGED_GUARD_MS = 30_000;

/**
 * The organization's address moved while this page stayed open, so its backend calls answer 409
 * `TENANT_ENDPOINT_CHANGED`. Leave for the organization root and let the server resolve the
 * current address itself (a page navigation to the old address is redirected there). The
 * `activeUrl` in the response body is deliberately not followed.
 */
const reresolveTenantEndpoint = (win: Window & typeof globalThis) => {
  const tenant = getTenant();
  if (!tenant) return;
  try {
    const last = Number(win.sessionStorage.getItem(ENDPOINT_CHANGED_GUARD_KEY));
    if (Date.now() - last < ENDPOINT_CHANGED_GUARD_MS) return;
    win.sessionStorage.setItem(ENDPOINT_CHANGED_GUARD_KEY, String(Date.now()));
  } catch {
    // Without storage the guard cannot hold across the navigation: do not risk a loop.
    return;
  }
  win.location.assign(new URL(tenant.basePath || '/', win.location.origin).toString());
};

const isEndpointChanged = async (response: Response) => {
  if (response.status !== 409) return false;
  try {
    return (
      ((await response.clone().json()) as { code?: unknown } | null)?.code === ENDPOINT_CHANGED
    );
  } catch {
    return false;
  }
};

const isEndpointChangedXhr = (xhr: XMLHttpRequest) => {
  try {
    const body: unknown =
      xhr.responseType === 'json'
        ? xhr.response
        : xhr.responseType === '' || xhr.responseType === 'text'
          ? JSON.parse(xhr.responseText)
          : null;
    return (body as { code?: unknown } | null)?.code === ENDPOINT_CHANGED;
  } catch {
    return false;
  }
};

/**
 * Prefixes same-origin backend calls made with `fetch`, `XMLHttpRequest` and `EventSource`, and
 * re-resolves the organization when the server says its endpoint changed.
 */
export const installTenantFetch = (win: Window & typeof globalThis = window) => {
  if (!win.location?.pathname || typeof win.fetch !== 'function') return;
  const tenant = getTenant();
  if (!tenant) return;
  // A custom authority serves the organization at its root: nothing to prefix.
  const tenantSlug = tenant.basePath === '' ? null : tenant.slug;

  const originalFetch = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl = toUrlString(input);
    const url = tenantRequestUrl(inputUrl, tenantSlug, win.location);
    const response = !url
      ? await originalFetch(input, init)
      : typeof input === 'string' || input instanceof URL
        ? await originalFetch(url, init)
        : await originalFetch(new Request(url, input), init);
    if (
      response.status === 409 &&
      isSameOriginBackendCall(inputUrl, win.location) &&
      (await isEndpointChanged(response))
    )
      reresolveTenantEndpoint(win);
    return response;
  };

  if (!tenantSlug) return;

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
      this.addEventListener('load', () => {
        if (this.status === 409 && isEndpointChangedXhr(this)) reresolveTenantEndpoint(win);
      });
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
