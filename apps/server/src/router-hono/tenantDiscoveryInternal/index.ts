import { isIP } from 'node:net';

import { Hono } from 'hono';
import { z } from 'zod';

import { appEnv } from '@/envs/app';
import { redisService } from '@/server/services/redis';
import { isAuthorized, parseControlPlaneToken } from '@/server/services/tenantControlPlane/auth';
import {
  discoveryAdmission,
  withDiscoveryDeadline,
} from '@/server/services/tenantDiscovery/admission';
import {
  DISCOVERY_MAX_BODY_BYTES,
  isJsonContentType,
  readDiscoveryJsonBody,
} from '@/server/services/tenantDiscovery/body';
import { loadDiscoveryCandidates } from '@/server/services/tenantDiscovery/candidates';
import { withLookupClient } from '@/server/services/tenantDiscovery/connection';
import { DiscoveryError } from '@/server/services/tenantDiscovery/errors';
import {
  discoveryEmailSchema,
  emailFingerprint,
  ipBucket,
} from '@/server/services/tenantDiscovery/protection';
import { queryTenantMembership } from '@/server/services/tenantDiscovery/query';

const BASE_PATH = '/api/internal/tenant-discovery';

/** A client address is usable only when it is a plain IPv4/IPv6 literal (no zone id). */
const clientIpSchema = z
  .string()
  .refine((value) => isIP(value) !== 0 && !value.includes('%'), 'invalid client ip');
const lookupBody = z.object({ clientIp: clientIpSchema, email: discoveryEmailSchema }).strict();

class RequestTooLargeError extends Error {
  constructor() {
    super('REQUEST_TOO_LARGE');
  }
}

export interface TenantDiscoveryInternalAppDeps {
  /** Digest of LOBEHUB_TENANT_DISCOVERY_TOKEN; null answers every request with 503. */
  tokenDigest: ReturnType<typeof parseControlPlaneToken>;
}

/**
 * Resolves the integration token. Missing, too short, or equal to the Console token disables
 * the endpoint (never crashes the process); the token itself is never logged.
 */
export const resolveTenantDiscoveryTokenDigest = (
  token: string | undefined,
  controlPlaneToken: string | undefined,
): ReturnType<typeof parseControlPlaneToken> => {
  if (!token) return null;
  if (token === controlPlaneToken) {
    console.error('TENANT_DISCOVERY_TOKEN_INVALID', 'SAME_AS_CONTROL_PLANE_TOKEN');
    return null;
  }
  try {
    return parseControlPlaneToken(token);
  } catch {
    console.error('TENANT_DISCOVERY_TOKEN_INVALID', 'TOO_SHORT');
    return null;
  }
};

const readJsonBody = async (request: Request, signal: AbortSignal): Promise<unknown> => {
  if (!isJsonContentType(request)) throw new DiscoveryError('INVALID_REQUEST', 400);
  if (Number(request.headers.get('content-length') ?? 0) > DISCOVERY_MAX_BODY_BYTES)
    throw new RequestTooLargeError();
  return readDiscoveryJsonBody(request, signal, () => new RequestTooLargeError());
};

/**
 * `/api/internal/tenant-discovery/*`: server-to-server tenant lookup for trusted backends
 * (the landing site). Same eligibility semantics as the public discovery, but the response
 * carries the slug and sign-in URL, authenticated by an independent Bearer token.
 */
export const createTenantDiscoveryInternalApp = (deps: TenantDiscoveryInternalAppDeps) => {
  const app = new Hono().basePath(BASE_PATH);

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'private, no-store');
  });

  app.onError((error, c) => {
    if (error instanceof RequestTooLargeError) return c.json({ code: 'REQUEST_TOO_LARGE' }, 413);
    if (error instanceof DiscoveryError) {
      if (error.retryAfter) c.header('Retry-After', String(error.retryAfter));
      return c.json({ code: error.code }, error.status as 400 | 429 | 503);
    }
    // Never serialize/log pg messages, DSNs, request URLs or email-bearing input.
    console.error('TENANT_DISCOVERY_UNAVAILABLE');
    return c.json({ code: 'TENANT_DISCOVERY_UNAVAILABLE' }, 503);
  });

  app.notFound((c) => c.json({ code: 'NOT_FOUND' }, 404));

  app.post('/lookup', async (c) => {
    // Authentication precedes body parsing and every Redis/DB access.
    if (!deps.tokenDigest) return c.json({ code: 'TENANT_DISCOVERY_DISABLED' }, 503);
    if (!isAuthorized(deps.tokenDigest, c.req.header('authorization')))
      return c.json({ code: 'TOKEN_INVALID' }, 401);

    const request = c.req.raw;
    return withDiscoveryDeadline(request.signal, async (signal) => {
      const parsed = lookupBody.safeParse(await readJsonBody(request, signal));
      if (!parsed.success) throw new DiscoveryError('INVALID_REQUEST', 400);
      const { clientIp, email } = parsed.data;
      const retryAfter = await redisService.tenantDiscovery.admit(
        'integration',
        ipBucket(clientIp),
        emailFingerprint(email),
      );
      if (retryAfter !== null) throw new DiscoveryError('RATE_LIMITED', 429, retryAfter);
      return discoveryAdmission.run(signal, async () => {
        const candidates = await loadDiscoveryCandidates(signal);
        signal.throwIfAborted();
        const found = await withLookupClient(signal, (client) =>
          queryTenantMembership(client, candidates, email),
        );
        signal.throwIfAborted();
        const tenants = [...found]
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
          .map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            // The mailbox is never echoed into the URL: the landing site hands the user over as-is.
            signinUrl: new URL(`${candidate.activeUrl}/signin`).href,
            slug: candidate.slug,
            url: candidate.activeUrl,
          }));
        return c.json({ tenants });
      });
    });
  });

  return app;
};

export default createTenantDiscoveryInternalApp({
  tokenDigest: resolveTenantDiscoveryTokenDigest(
    appEnv.LOBEHUB_TENANT_DISCOVERY_TOKEN,
    appEnv.LOBEHUB_CONTROL_PLANE_TOKEN,
  ),
});
