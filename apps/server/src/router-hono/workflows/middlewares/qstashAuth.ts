import { recordUpstashWorkflowEvent } from '@lobechat/observability-otel/modules/upstash-workflow';
import { errorNameFrom } from '@lobechat/utils';
import debug from 'debug';
import type { MiddlewareHandler } from 'hono';

import { getDeliverySigningKey, verifyDeliveryRequest } from '@/server/modules/Hatchet/signature';

const log = debug('lobe-server:workflows:qstash-auth');

/**
 * Hono middleware that verifies the `Upstash-Signature` header a direct
 * delivery (Hatchet, or in-process in local mode) signs its request with.
 *
 * - When `DELIVERY_SIGNING_KEY` is unset (dev / electron), verification
 *   is skipped, as deliveries then go unsigned.
 * - On signature mismatch, returns `401 Invalid signature` and aborts the
 *   handler chain.
 * - The body is consumed via `c.req.text()` to compute the HMAC; downstream
 *   handlers can still call `c.req.json()` because Hono caches across body
 *   formats (`bodyCache` cross-converts text ↔ json).
 *
 * Use for one-shot delivery receivers. Workflow routes (`serve()` from
 * `@/server/modules/Workflow`) verify the signature themselves.
 */
export const qstashAuth = (): MiddlewareHandler => async (c, next) => {
  if (getDeliverySigningKey()) {
    const rawBody = await c.req.text();

    const ok = verifyDeliveryRequest(c.req.raw, rawBody);
    if (!ok) {
      log('Rejected: invalid delivery signature on %s', c.req.path);
      recordUpstashWorkflowEvent({
        errorType: 'InvalidSignature',
        interface: 'qstash',
        operation: 'serve',
        path: c.req.path,
        status: 'error',
      });

      return c.json({ error: 'Invalid signature' }, 401);
    }
  }
  try {
    await next();

    recordUpstashWorkflowEvent({
      interface: 'qstash',
      operation: 'serve',
      path: c.req.path,
      status: 'success',
    });
  } catch (error) {
    recordUpstashWorkflowEvent({
      errorType: errorNameFrom(error) ?? typeof error,
      interface: 'qstash',
      operation: 'serve',
      path: c.req.path,
      status: 'error',
    });

    throw error;
  }
};
