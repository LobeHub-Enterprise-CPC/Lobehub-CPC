import { useInteractionDetails } from './OAuthConsent/useInteractionDetails';

/** The OIDC client id the desktop app signs in with. */
export const DESKTOP_CLIENT_ID = 'lobehub-desktop';

export const isDesktopClientId = (clientId: string | null | undefined): boolean =>
  clientId === DESKTOP_CLIENT_ID;

const parseCallback = (callbackUrl: string | null | undefined): URL | null => {
  if (!callbackUrl) return null;
  try {
    return new URL(callbackUrl);
  } catch {
    // A path: resolve it against this page.
    try {
      return new URL(callbackUrl, window.location.href);
    } catch {
      return null;
    }
  }
};

/** `callbackUrl` is the authorization request itself (`…/oidc/auth?client_id=lobehub-desktop…`). */
export const isDesktopAuthorizeCallback = (callbackUrl: string | null | undefined): boolean => {
  const url = parseCallback(callbackUrl);
  if (!url || !/\/oidc\/auth\/?$/.test(url.pathname)) return false;
  return isDesktopClientId(url.searchParams.get('client_id'));
};

/**
 * Interaction pages the provider can send the browser to, each capturing the uid:
 * the consent page and the login-prompt page (which carries an optional tenant
 * prefix and may end with a slash).
 */
const INTERACTION_PATHS = [
  /\/oauth\/consent\/([^/?#]+)\/?$/,
  /\/oidc\/interaction\/([^/?#]+)\/login\/?$/,
];

/** `callbackUrl` is the OIDC interaction page the provider sent the browser to. */
export const interactionUidOf = (callbackUrl: string | null | undefined): string | null => {
  const url = parseCallback(callbackUrl);
  if (!url) return null;

  for (const path of INTERACTION_PATHS) {
    const uid = path.exec(url.pathname)?.[1];
    if (uid) return decodeURIComponent(uid);
  }
  return null;
};

/**
 * Whether the sign-in this page serves belongs to the desktop app's authorization.
 *
 * The provider sends the browser to `/oauth/consent/:uid` and the sign-in page is reached
 * from there, so `callbackUrl` usually names an interaction, not the client; the client is
 * then read from the interaction itself. A lookup that fails counts as "not desktop".
 */
export const useDesktopAuthContext = (callbackUrl: string | null | undefined): boolean => {
  const direct = isDesktopAuthorizeCallback(callbackUrl);
  const uid = direct ? null : interactionUidOf(callbackUrl);
  const { data } = useInteractionDetails(uid ?? undefined);
  return direct || isDesktopClientId(data?.clientId);
};
