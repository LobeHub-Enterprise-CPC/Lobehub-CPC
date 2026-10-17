import { getTenant, withCurrentTenantPath } from '@lobechat/business-tenant/client';
import { parseTenantPath, stripTenantPath } from '@lobechat/business-tenant/routing';

const ONBOARDING_PATH = '/onboarding';
const CALLBACK_STORAGE_KEY = 'onboarding-callback-url';

/**
 * Only same-site relative paths are allowed as post-onboarding redirect
 * targets, to prevent open redirects (e.g. `https://evil.com`, `//evil.com`).
 * Backslashes are rejected because browsers normalize `\` to `/` in
 * navigations, so `/\evil.com` would escape as a protocol-relative URL.
 */
export const isSafeRedirectPath = (url: string): boolean =>
  url.startsWith('/') && !url.startsWith('//') && !url.includes('\\');

/**
 * App paths (`/`, `/onboarding`, …) that leave the auth flow as full-page
 * destinations keep the `/t/{slug}` of the page the flow runs on: the app only
 * exists under its tenant, and a bare `/` lands on the no-tenant page.
 */
const withPageTenant = (path: string): string => {
  return withCurrentTenantPath(path);
};

/**
 * Auth detours can produce same-origin absolute callback URLs (e.g. the
 * protected-route proxy builds `APP_URL + pathname + search`) — normalize
 * them to relative paths instead of dropping them as unsafe. Normalize browser
 * dot segments before checking the destination's tenant.
 */
const toRelativePath = (url: string): string => {
  if (typeof window === 'undefined') return url;
  if (!isSafeRedirectPath(url) && !/^https?:\/\//.test(url)) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin
      ? parsed.pathname + parsed.search + parsed.hash
      : parsed.href;
  } catch {
    // fall through — non-parsable URLs are rejected by isSafeRedirectPath
  }
  return url;
};

/**
 * Sanitize a user-supplied redirect target before it reaches
 * `window.location.href`: same-origin absolute URLs are normalized to relative
 * paths, anything unsafe (`javascript:`, `https://evil.com`, `//…`) falls back,
 * and the result keeps the page's tenant prefix.
 */
export const sanitizeRedirectPath = (url: string | null | undefined, fallback = '/'): string => {
  if (!url) return withPageTenant(fallback);
  const target = toRelativePath(url);
  const pageTenant = getTenant()?.slug;
  const targetTenant = parseTenantPath(target).tenantSlug;
  const sameTenant =
    getTenant()?.basePath === ''
      ? !targetTenant
      : !pageTenant || !targetTenant || pageTenant === targetTenant;
  return withPageTenant(isSafeRedirectPath(target) && sameTenant ? target : fallback);
};

/**
 * Better Auth resolves relative callbacks against its server base URL, but auth pages can run on a
 * different origin. Bind safe web paths to the browser's current origin (and the page's tenant)
 * before sending them to the server, while preserving explicit absolute URLs and mobile schemes.
 */
export const toAbsoluteAuthCallbackUrl = (callbackUrl: string, origin: string): string =>
  isSafeRedirectPath(callbackUrl)
    ? new URL(sanitizeRedirectPath(callbackUrl), origin).toString()
    : callbackUrl;

/**
 * Build the first-hop URL for a freshly signed-up user. New users always land
 * on onboarding first; the original target (if any) is threaded through the
 * `callbackUrl` query param and restored when onboarding finishes.
 */
export const buildOnboardingRedirectUrl = (callbackUrl?: string | null): string => {
  const onboardingPath = withPageTenant(ONBOARDING_PATH);
  const target = sanitizeRedirectPath(callbackUrl, ONBOARDING_PATH);
  const appPath = stripTenantPath(target);
  if (appPath === '/') return onboardingPath;
  if (/^\/onboarding(?:[/?#]|$)/.test(appPath)) return target;
  return `${onboardingPath}?callbackUrl=${encodeURIComponent(target)}`;
};

/**
 * Persist the threaded callbackUrl when landing on onboarding. sessionStorage
 * (rather than query threading) survives the internal multi-route hops of the
 * onboarding flow and mid-flow page refreshes.
 */
export const stashOnboardingCallbackUrl = (search: string): void => {
  try {
    const callbackUrl = new URLSearchParams(search).get('callbackUrl');
    if (callbackUrl && isSafeRedirectPath(callbackUrl))
      sessionStorage.setItem(CALLBACK_STORAGE_KEY, callbackUrl);
  } catch {
    // sessionStorage unavailable (e.g. privacy mode) — finish points fall back to defaults
  }
};

/**
 * Drop a stale stashed callback left by a previously abandoned onboarding
 * attempt in this tab. Only a fresh top-level entry (`/onboarding` without a
 * valid `callbackUrl`) may clear: internal step changes stay on `/onboarding`
 * itself or re-enter it with an explicit `?step` param, and must keep the
 * stash intact.
 */
export const clearStaleOnboardingCallbackUrl = (pathname: string, search: string): void => {
  if (stripTenantPath(pathname) !== ONBOARDING_PATH) return;
  const params = new URLSearchParams(search);
  if (params.has('step')) return;
  const callbackUrl = params.get('callbackUrl');
  if (callbackUrl && isSafeRedirectPath(callbackUrl)) return;
  try {
    sessionStorage.removeItem(CALLBACK_STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const peekOnboardingCallbackUrl = (): string | undefined => {
  try {
    const url = sessionStorage.getItem(CALLBACK_STORAGE_KEY);
    return url && isSafeRedirectPath(url) ? url : undefined;
  } catch {
    return undefined;
  }
};

/** Read and clear the stashed callbackUrl — call once when onboarding finishes. */
export const consumeOnboardingCallbackUrl = (): string | undefined => {
  const url = peekOnboardingCallbackUrl();
  try {
    sessionStorage.removeItem(CALLBACK_STORAGE_KEY);
  } catch {
    // ignore
  }
  return url;
};

export const resolvePostOnboardingTargetUrl = (): string => {
  const target = sanitizeRedirectPath(consumeOnboardingCallbackUrl());
  if (!getTenant()) return target;
  // React Router adds the tenant basename to this internal navigation.
  const appPath = stripTenantPath(target);
  return appPath.startsWith('/') ? appPath : `/${appPath}`;
};
