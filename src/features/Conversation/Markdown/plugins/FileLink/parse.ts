import { currentTenantRelativePath } from '@lobechat/business-tenant/client';
import { relativeToRemoteBase } from '@lobechat/utils/remoteUrl';

export const LOBE_FILE_LINK_TAG = 'lobeFileLink';

// Matches this app's own file proxy path, e.g. `${APP_URL}/t/{slug}/f/:fileId`
// (see server/routers/lambda/file.ts -> getFileProxyUrl). This is deliberately
// narrower than Link/internalLink.ts's NON_SPA_ROUTE_ROOTS exclusion of `/f`:
// that keeps the generic link classifier out of the file proxy entirely, so
// this plugin claims the anchor first and gives it its own preview affordance.
const FILE_PROXY_PATH_REGEX = /^\/f\/([^/?#]+)\/?$/;

export interface ParsedFileLink {
  fileId: string;
}

/**
 * The path below this app's tenant prefix, or `null` when the pathname belongs
 * to another tenant.
 *
 * A web document knows its tenant from its own URL. The desktop renderer is not
 * a tenant document: it is served from `app://`, and the tenant is the path of
 * the remote server address it is connected to (`https://host/t/acme`), so that
 * address decides which `/t/{slug}` prefix is ours.
 */
const appRelativePath = (
  pathname: string,
  isRootRelative: boolean,
  appUrl: URL | undefined,
): string | null => {
  if (!appUrl || appUrl.pathname.replaceAll(/\/+$/g, '') === '') {
    return currentTenantRelativePath(pathname);
  }

  const below = relativeToRemoteBase(pathname, appUrl);
  if (below !== null) return below;

  // A root-relative link without a prefix is relative to the app address itself;
  // one that names another tenant is not ours.
  return isRootRelative && !/^\/t(?:\/|$)/.test(pathname) ? pathname : null;
};

/**
 * @param currentAppUrl The address the app is served from: the page origin on
 * web, the remote server address on desktop (which may carry a `/t/{slug}`
 * tenant path). Absolute links must be on its origin to be ours.
 */
export const parseFileLinkHref = (
  href: string | undefined,
  currentAppUrl?: string,
): ParsedFileLink | null => {
  if (!href) return null;

  const isRootRelative = href.startsWith('/') && !href.startsWith('//');
  let url: URL;
  let appUrl: URL | undefined;

  try {
    appUrl = currentAppUrl ? new URL(currentAppUrl) : undefined;
    url = new URL(href, appUrl?.origin || 'https://lobehub.com');
  } catch {
    return null;
  }

  // Only intercept links that point back at this app's own file proxy, never
  // an externally hosted link that happens to share the path shape. A
  // root-relative href is inherently same-origin; an absolute one needs an
  // explicit origin to compare against, so without one it's left alone.
  if (!isRootRelative) {
    if (!appUrl) return null;
    if (url.origin !== appUrl.origin) return null;
  }

  const match = appRelativePath(url.pathname, isRootRelative, appUrl)?.match(FILE_PROXY_PATH_REGEX);
  if (!match) return null;

  try {
    return { fileId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
};
