import { recordUpstashWorkflowEvent } from '@lobechat/observability-otel/modules/upstash-workflow';
import { errorNameFrom } from '@lobechat/utils';
import debug from 'debug';
import type { MiddlewareHandler } from 'hono';

import { verifyDeliveryRequest } from '@/server/modules/Hatchet/signature';

const log = debug('lobe-server:agent:qstash-auth');

/**
 * Hono middleware that requires a valid delivery signature on the request;
 * without `DELIVERY_SIGNING_KEY` every request is rejected.
 *
 * The body is consumed via `c.req.text()` to compute the HMAC;
 * downstream handlers can still call `c.req.json()` thanks to Hono's
 * bodyCache cross-conversion.
 */
export const qstashAuth = (): MiddlewareHandler => async (c, next) => {
  const rawBody = await c.req.text();
  const isValid = verifyDeliveryRequest(c.req.raw, rawBody);

  if (!isValid) {
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
