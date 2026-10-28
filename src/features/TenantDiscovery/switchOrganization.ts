import { getTenant } from '@lobechat/business-tenant/client';

const SWITCH_QUERY_PATH = '/?switch=1';

/**
 * The deployment root the server injected for this document (`appUrl`, on the auth and the
 * main SPA alike). Read defensively: an absent or malformed value means "unknown" rather
 * than a guess.
 */
const readConfiguredAppUrl = (): string | null => {
  const raw: unknown = window.__SERVER_CONFIG__?.appUrl;
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
};

/**
 * Where "Switch organization" leads: the deployment root with the lookup page forced
 * open. `null` when this document belongs to no organization (the lookup page itself)
 * or when the root cannot be determined, so callers render no link at all.
 *
 * `originFallback` is for pages that must stay reachable when the server config carries
 * no `appUrl` (the main app's "organization unavailable" screens): the page origin is the
 * deployment root for a path-addressed organization, but not for a custom domain, whose
 * origin is the organization itself. A configured `appUrl` wins over it, custom domain or not.
 */
export const getSwitchOrganizationUrl = ({
  originFallback = false,
}: { originFallback?: boolean } = {}): string | null => {
  const tenant = getTenant();
  if (!tenant) return null;

  const appUrl = readConfiguredAppUrl();
  if (appUrl) return `${appUrl}${SWITCH_QUERY_PATH}`;

  if (!originFallback || tenant.basePath === '') return null;
  return `${window.location.origin}${SWITCH_QUERY_PATH}`;
};
