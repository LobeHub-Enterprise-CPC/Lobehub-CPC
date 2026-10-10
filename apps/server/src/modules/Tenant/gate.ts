import { stripTenantPath } from '@lobechat/const/tenantPath';
import { runWithTenantScope, TenantDatabaseError } from '@lobechat/database/tenant';
import debug from 'debug';
import { NextRequest } from 'next/server';

import { TenantGateError } from './errors';
import { TENANT_ROUTE_HEADER, verifyTenantRoute } from './routeHeader';
import { getTenantRuntime } from './runtime';

const log = debug('lobe-server:tenant-gate');

/** The slug the proxy routed this request to, or null. */
export const routedTenantSlug = (request: Request): string | null =>
  verifyTenantRoute(request.headers.get(TENANT_ROUTE_HEADER));

const toResponse = (error: unknown): Response | null => {
  if (error instanceof TenantGateError) return error.toResponse();
  if (error instanceof TenantDatabaseError) {
    log('tenant database refused: %s', error.reason);
    return new TenantGateError(
      error.code === 'TENANT_REQUIRED' ? 'TENANT_REQUIRED' : error.code,
    ).toResponse();
  }
  return null;
};

/**
 * Runs a backend handler inside its tenant (spec FR-RT-04, FR-ID-07 steps 1–2,
 * FR-DI-09): the routed slug is resolved, the tenant's lifecycle is checked,
 * and the tenant database is bound for everything the handler awaits. A
 * request without a tenant is refused with `TENANT_REQUIRED`; there is no
 * default tenant and no fallback connection.
 */
export const withTenantRequest =
  <Req extends Request, Args extends unknown[]>(
    handler: (request: Req, ...args: Args) => Promise<Response> | Response,
  ) =>
  async (request: Req, ...args: Args): Promise<Response> => {
    const slug = routedTenantSlug(request);
    if (!slug) return new TenantGateError('TENANT_REQUIRED').toResponse();
    try {
      const scope = await getTenantRuntime().admitSlug(slug);
      // Next rewrites route selection but retains the original URL on Request.
      // Downstream adapters (tRPC, Hono, auth) are mounted at unprefixed paths.
      const url = new URL(request.url);
      const pathname = stripTenantPath(url.pathname);
      let routedRequest = request;
      if (pathname !== url.pathname) {
        url.pathname = pathname;
        routedRequest = (
          request instanceof NextRequest ? new NextRequest(url, request) : new Request(url, request)
        ) as Req;
      }
      return await runWithTenantScope(scope, () => handler(routedRequest, ...args));
    } catch (error) {
      const response = toResponse(error);
      if (response) return response;
      throw error;
    }
  };

/** Same as {@link withTenantRequest} for a job whose tenant id came from a verified payload. */
export const runInTenant = async <T>(tenantId: string, operation: () => Promise<T>): Promise<T> => {
  const scope = await getTenantRuntime().admitTenantId(tenantId);
  return runWithTenantScope(scope, operation);
};
