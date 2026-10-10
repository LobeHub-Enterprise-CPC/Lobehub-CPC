import { stripTenantPath } from '@lobechat/business-tenant/routing';
import { runWithTenantScope, TenantDatabaseError } from '@lobechat/database/tenant';
import debug from 'debug';
import type { NextRequest } from 'next/server';

import { TenantGateError, tenantGateErrorOf } from './errors';
import { getTenantLiveResources, guardTenantStream } from './liveResources';
import { TENANT_ROUTE_HEADER, verifyTenantRoute } from './routeHeader';
import { getTenantRuntime } from './runtime';

const log = debug('lobe-server:tenant-gate');

/** The slug the proxy routed this request to, or null. */
export const routedTenantSlug = (request: Request): string | null =>
  verifyTenantRoute(request.headers.get(TENANT_ROUTE_HEADER));

const toResponse = (error: unknown): Response | null => {
  const refusal = tenantGateErrorOf(error);
  if (refusal) return refusal.toResponse();
  if (error instanceof TenantDatabaseError) {
    log('tenant database refused: %s', error.reason);
    return new TenantGateError(
      error.code === 'TENANT_REQUIRED' ? 'TENANT_REQUIRED' : error.code,
    ).toResponse();
  }
  return null;
};

/**
 * A response body outlives the handler (SSE, streamed model output, file
 * downloads), so it is registered as the tenant's live resource and fails
 * when the tenant is frozen or taken offline (FR-CP-06 stage 2).
 */
const guardTenantResponse = (
  tenantId: string,
  response: Response,
  controller: AbortController,
): Response => {
  if (!response.body) return response;
  return new Response(
    guardTenantStream(getTenantLiveResources(), tenantId, response.body, (reason) =>
      controller.abort(reason),
    ),
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
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
      const { scope, release } = await getTenantRuntime().enterSlug(slug);
      scope.trackWork = (resource) => getTenantLiveResources().bind(scope.tenantId, resource);
      const controller = new AbortController();
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let unbind = () => {};
      try {
        unbind = getTenantLiveResources().bind(scope.tenantId, {
          close: (reason) => controller.abort(reason),
          settled,
        });
        // Next.js proxies requests and binds their constructors/methods. Reconstructing
        // one loses private slots; override only cancellation and preserve its accessors.
        const signal = AbortSignal.any([request.signal, controller.signal]);
        const url = new URL(request.url);
        url.pathname = stripTenantPath(url.pathname);
        const wrap = (target: Req): Req =>
          new Proxy(Object.create(target) as Req, {
            get(_facade, key) {
              const original = target;
              if (key === 'signal') return signal;
              if (key === 'url') return url.href;
              if (key === 'clone') return () => wrap(original.clone() as Req);
              const value = Reflect.get(original, key, original);
              if (key === 'nextUrl' && value) {
                const originalUrl = value as unknown as NextRequest['nextUrl'] | URL;
                const nextUrl =
                  'clone' in originalUrl ? originalUrl.clone() : new URL(originalUrl.href);
                nextUrl.pathname = url.pathname;
                return nextUrl;
              }
              return typeof value === 'function' ? value.bind(original) : value;
            },
          });
        const abortable = wrap(request);
        const response = await runWithTenantScope(scope, () => handler(abortable, ...args));
        return guardTenantResponse(scope.tenantId, response, controller);
      } finally {
        finish();
        unbind();
        await release();
      }
    } catch (error) {
      const response = toResponse(error);
      if (response) return response;
      throw error;
    }
  };

/** Same as {@link withTenantRequest} for a job whose tenant id came from a verified payload. */
export const runInTenant = async <T>(tenantId: string, operation: () => Promise<T>): Promise<T> => {
  const { scope, release } = await getTenantRuntime().enterTenantId(tenantId);
  scope.trackWork = (resource) => getTenantLiveResources().bind(tenantId, resource);
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let unbind = () => {};
  try {
    unbind = getTenantLiveResources().bind(tenantId, { close: () => {}, settled });
    return await runWithTenantScope(scope, operation);
  } finally {
    finish();
    unbind();
    await release();
  }
};
