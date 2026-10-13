import { parseTenantPath } from './path';

/** A tenant's active public entry: `https://host/t/{slug}` or a custom domain root. */
export interface TenantPublicEntry {
  readonly publicUrl: string;
  readonly slug: string;
}

/**
 * The app path a URL for this tenant addresses. Rejects relative paths, path
 * escapes and another tenant's `/t/{slug}`; strips this tenant's own prefix, so
 * callers may pass either form. A public URL helper must never name another tenant.
 */
export const tenantAppPath = (path: string, slug: string): string => {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('Public URL requires an app path');
  const pathname = path.split(/[?#]/, 1)[0];
  for (const segment of pathname.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error('Invalid public URL path');
    }
    if (decoded === '.' || decoded === '..' || /[\\/]/.test(decoded))
      throw new Error('Invalid public URL path');
  }
  const parsed = parseTenantPath(path);
  if (/^\/t(?:\/|$)/.test(path) && parsed.tenantSlug !== slug)
    throw new Error('Public URL addresses another tenant');
  return parsed.rest;
};

/**
 * Absolute URL of an app path (query allowed) on a tenant's active public entry:
 * `/oauth/x` -> `https://host/t/acme/oauth/x`, or `https://custom.host/oauth/x`.
 * The entry is resolved by the caller (request scope, or a lookup by tenant id).
 */
export const buildTenantEntryUrl = (entry: TenantPublicEntry, path: string): string => {
  const appPath = tenantAppPath(path, entry.slug);
  return `${entry.publicUrl.replace(/\/+$/, '')}${appPath === '/' ? '' : appPath}`;
};
