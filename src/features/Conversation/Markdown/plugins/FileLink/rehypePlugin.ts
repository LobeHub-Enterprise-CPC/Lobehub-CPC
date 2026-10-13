import { getAppBaseUrl } from '@lobechat/business-tenant/client';
import { isDesktop } from '@lobechat/const';
import { SKIP, visit } from 'unist-util-visit';

import { LOBE_FILE_LINK_TAG, parseFileLinkHref } from './parse';

const getNodeText = (node: any): string => {
  if (!node) return '';
  if (node.type === 'text') return String(node.value ?? '');
  if (Array.isArray(node.children)) return node.children.map(getNodeText).join('');
  return '';
};

/**
 * The address file links should be classified against. On desktop the
 * renderer's own origin isn't the app's — exported files are absolute URLs
 * pointing at the remote server (`https://host/t/acme/f/:id` for a tenant), so
 * its address, tenant path included, is what has to match (the tenant package's
 * app address, see getAppBaseUrl).
 */
const getCurrentOrigin = (): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  if (!isDesktop) return window.location.origin;

  return getAppBaseUrl() || undefined;
};

/**
 * Rehype plugin that rewrites `<a href="{APP_URL}/f/:fileId">` anchors —
 * produced by assistant tool output such as code execution file export —
 * into a custom `<lobeFileLink>` element, so they open the in-app file
 * preview panel instead of navigating away. Must run before Link's generic
 * `rehypeLobeLink`, which would otherwise consume the same anchor first.
 */
export const rehypeFileLink = () => (tree: any) => {
  visit(tree, 'element', (node: any) => {
    if (node.tagName !== 'a') return;

    const href = node.properties?.href as string | undefined;
    const parsed = parseFileLinkHref(href, getCurrentOrigin());
    if (!parsed) return;

    const text = getNodeText(node).trim();
    const label = text || parsed.fileId;

    node.tagName = LOBE_FILE_LINK_TAG;
    node.children = [];
    node.properties = {
      fileId: parsed.fileId,
      linkHref: href,
      linkLabel: label,
    };

    return SKIP;
  });
};
