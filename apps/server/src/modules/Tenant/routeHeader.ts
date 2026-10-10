import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { isWellFormedTenantSlug } from '@lobechat/business-tenant/routing';

/**
 * Hand-off of the resolved tenant from the request proxy (`src/proxy.ts`) to
 * the backend route handlers, which only see the rewritten, unprefixed path.
 *
 * The proxy is the single place that reads the tenant from the request
 * (`/t/{slug}` today, a Host mapping later, spec A17). It always strips any
 * incoming value of this header, then sets `<slug>.<mac>` for a tenant path.
 * The MAC (HMAC-SHA256 under a key derived from `KEY_VAULTS_SECRET`) means a
 * route reached without going through the proxy cannot be handed a tenant by
 * a client-supplied header (spec I-1: a header never selects the tenant).
 */
export const TENANT_ROUTE_HEADER = 'x-lobe-tenant-route';

const ROUTE_KEY_INFO = 'lobehub:tenant-route';

const routeKey = (env: Record<string, string | undefined> = process.env) => {
  const secret = env.KEY_VAULTS_SECRET;
  if (!secret) return null;
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(ROUTE_KEY_INFO),
      32,
    ),
  );
};

const mac = (key: Buffer, slug: string) =>
  createHmac('sha256', key).update(slug, 'utf8').digest('base64url');

/** `null` when no master secret is configured: no tenant can be routed. */
export const signTenantRoute = (slug: string): string | null => {
  const key = routeKey();
  if (!key || !isWellFormedTenantSlug(slug)) return null;
  return `${slug}.${mac(key, slug)}`;
};

/** The slug the proxy routed, or `null` for a missing, forged or malformed value. */
export const verifyTenantRoute = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const slug = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'utf8');
  const key = routeKey();
  if (!key || !isWellFormedTenantSlug(slug)) return null;
  const expected = Buffer.from(mac(key, slug), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected) ? slug : null;
};
