import { stripTenantPath } from '@lobechat/business-tenant/routing';
import { Hono } from 'hono';
import { getPath } from 'hono/utils/url';

import { tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import { runInTenantSlug } from '@/server/modules/Tenant/gate';
import memoryUserMemoryApp from '@/server/router-hono/workflows/memory-user-memory';

import { deliver, type DeliveryResponse, type LoopbackTransport } from './deliver';
import { trackInProcessWork } from './inProcessWork';
import { memoryWorkflowTenantSlug } from './memoryRoute';
import type { DeliveryAttempt, DeliveryInput, DeliveryOutcome } from './types';

// The web app's workflow routing (router-hono/workflows) with only the memory routes mounted.
const app = new Hono({ getPath: (request) => stripTenantPath(getPath(request)) })
  .basePath('/api/workflows')
  .route('/memory-user-memory', memoryUserMemoryApp);

/** Settles like `work`, or rejects once `signal` aborts first. */
const untilAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });

/**
 * Serves a delivery to the memory routes inside its tenant, as the web route shell does
 * behind the proxy: a tenant refusal answers with its gate response, and the request is
 * aborted if the tenant is frozen or taken offline while it runs.
 */
const serveInTenant =
  (slug: string, url: string): LoopbackTransport =>
  (_loopbackUrl, headers, body, signal) => {
    const closed = new AbortController();
    // Addressed by `url` itself; the loopback Host only matters to an HTTP listener.
    const forwarded = new Headers(headers);
    forwarded.delete('Host');
    const request = new Request(url, {
      body,
      headers: forwarded,
      method: 'POST',
      signal: AbortSignal.any([signal, closed.signal]),
    });
    const handled = trackInProcessWork(
      (async (): Promise<DeliveryResponse> => {
        try {
          return await runInTenantSlug(
            slug,
            async () => {
              const response = await app.fetch(request);
              await response.body?.cancel();
              return { headers: response.headers, status: response.status };
            },
            (reason) => closed.abort(reason),
          );
        } catch (error) {
          const refusal = tenantGateErrorOf(error);
          if (!refusal) throw error;
          const response = refusal.toResponse();
          return { headers: response.headers, status: response.status };
        }
      })(),
    );
    // The attempt ends at its HTTP timeout, as over HTTP; the handler finishes behind the run lock.
    return untilAborted(handled, signal);
  };

/**
 * Delivers a `cpc-memory-delivery` run in this process. Only memory workflow addresses of
 * this app are served, and only in the tenant the run was published for.
 */
export const deliverMemoryInProcess = async (
  input: DeliveryInput,
  attempt: DeliveryAttempt,
): Promise<DeliveryOutcome> => {
  let slug: string | undefined;
  try {
    slug = memoryWorkflowTenantSlug(new URL(input.url));
  } catch {
    slug = undefined;
  }
  if (!slug || slug !== input.tenantKey) {
    console.error({ event: 'memory.delivery.refused', tenantKey: input.tenantKey, url: input.url });
    return { kind: 'failed', reason: 'InvalidInput' };
  }
  return deliver(input, attempt, { loopback: serveInTenant(slug, input.url) });
};
