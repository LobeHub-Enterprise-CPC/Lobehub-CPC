import { buildTenantPath, stripTenantPath } from '@lobechat/const/tenantPath';
import { requireTenantScope } from '@lobechat/database/tenant';

import { getAppOriginUrl, getInternalApiUrl } from '@/envs/appUrl';

/**
 * Addresses for work this server hands to itself later: QStash and Upstash
 * Workflow callbacks, agent hooks, webhooks registered with a bot platform,
 * and server-to-server tRPC (spec FR-AS-01, FR-RT-05).
 *
 * The callback carries its tenant in the URL it is delivered to, so it goes
 * through the request proxy like any other tenant request: the proxy signs the
 * routed tenant, `withTenantRequest` admits it and binds the tenant database,
 * and a callback without a tenant is refused with `TENANT_REQUIRED`. QStash
 * signs the delivery, and the tenant id is never taken from the body.
 *
 * This is the one place that decides how a callback names its tenant. Today
 * that is the `/t/{slug}` prefix (slugs never change once created); if tenants
 * move to their own Host (spec A17), only this module and the proxy's
 * resolution change.
 */

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * `path` under the current tenant, e.g. `/t/acme/api/workflows/goal/advance`.
 * Throws `TENANT_REQUIRED` outside a tenant scope: a callback scheduled
 * without a tenant could never be admitted.
 */
export const tenantCallbackPath = (path: string): string =>
  buildTenantPath(path.startsWith('/') ? path : `/${path}`, requireTenantScope().slug);

/** Absolute callback URL for `path` under the current tenant (server-to-server base by default). */
export const buildTenantCallbackUrl = (
  path: string,
  baseUrl: string = getInternalApiUrl(),
): string => {
  if (!baseUrl) throw new Error('APP_URL is required to build a callback URL');
  return `${trimTrailingSlash(baseUrl)}${tenantCallbackPath(path)}`;
};

/**
 * The request as the caller addressed it, with the tenant prefix the proxy
 * strips before routing. Upstash Workflow derives every later step's URL from
 * the URL of the request it is serving, so the workflow handler must see the
 * tenant address or its next step would arrive without a tenant.
 */
export const withTenantRequestUrl = (request: Request): Request => {
  const url = new URL(request.url);
  url.pathname = tenantCallbackPath(stripTenantPath(url.pathname));
  if (url.href === request.url) return request;
  return new Request(url, {
    body: request.body,
    // Required by undici for a streamed body.
    duplex: 'half',
    headers: request.headers,
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
  } as RequestInit);
};

/**
 * The current tenant's public base (`APP_URL/t/{slug}`) for an external
 * service that calls us back (bot platform webhooks, message gateway) or a
 * link a person opens from a bot message.
 */
export const tenantPublicBaseUrl = (): string => buildTenantCallbackUrl('/', getAppOriginUrl());
