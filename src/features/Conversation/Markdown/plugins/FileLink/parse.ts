import { currentTenantRelativePath } from '@lobechat/business-tenant/client';
import { hasTenantPrefix } from '@lobechat/business-tenant/routing';
import { relativeToRemoteBase } from '@lobechat/utils/remoteUrl';

export const LOBE_FILE_LINK_TAG = 'lobeFileLink';

// Matches this app's own file proxy path, e.g. `${APP_URL}/orgs/{slug}/f/:fileId`
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
 * the remote server address it is connected to (`https://host/orgs/acme`), so that
 * address decides which `/orgs/{slug}` prefix is ours.
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

  // A link that names another slug of the same tenant (the address may predate a
  // rename) is ours; one that names another tenant is not. A root-relative link
  // without a prefix is relative to the app address itself.
  if (hasTenantPrefix(pathname)) return currentTenantRelativePath(pathname);
  return isRootRelative ? pathname : null;
};

/**
 * @param currentAppUrl The address the app is served from: the page origin on
 * web, the remote server address on desktop (which may carry a `/orgs/{slug}`
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

// A link label that names a file, e.g. `report.md` or `action-items.csv`.
const FILE_NAME_WITH_EXTENSION_REGEX = /\.[\da-z]{1,10}$/i;

export type FileLinkOpenAction =
  | { kind: 'preview'; params: { fileId: string; source?: { name: string; url: string } } }
  | { kind: 'newTab'; url: string };

/**
 * What a file link click opens.
 *
 * The agent-share visitor does not own the creator's files, so the portal's
 * owner-scoped fetch by id finds nothing and shows "file unavailable"; the
 * `/f/:id` link itself is public by id, so the visitor previews straight from
 * it. That preview only knows the file through the link label (the FileViewer
 * picks its renderer from the name's extension), so a label such as
 * "Download the deck" opens the public link in a new tab instead of a preview
 * that would render the file with the wrong viewer.
 */
export const getFileLinkOpenAction = ({
  fileId,
  isAgentShareVisitor,
  label,
  linkHref,
}: {
  fileId: string;
  isAgentShareVisitor: boolean;
  label: string;
  linkHref?: string;
}): FileLinkOpenAction => {
  if (!isAgentShareVisitor || !linkHref) return { kind: 'preview', params: { fileId } };

  if (!FILE_NAME_WITH_EXTENSION_REGEX.test(label.trim())) return { kind: 'newTab', url: linkHref };

  return { kind: 'preview', params: { fileId, source: { name: label.trim(), url: linkHref } } };
};
