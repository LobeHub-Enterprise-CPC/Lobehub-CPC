import { z } from 'zod';

import { appEnv } from '@/envs/app';
import { redisService } from '@/server/services/redis';

import { discoveryAdmission, withDiscoveryDeadline } from './admission';
import { loadDiscoveryCandidates } from './candidates';
import { withLookupClient } from './connection';
import { readDesktopHandoff, selectDesktopTenant } from './desktop';
import { desktopFlowSchema } from './desktopFlow';
import { DiscoveryError } from './errors';
import { serializeTenantCookie } from './navigation';
import { discoveryIpBucket, emailFingerprint } from './protection';
import { discoveryResults, queryTenantMembership, verifyCandidateObjects } from './query';

export { discoveryIpBucket, emailFingerprint } from './protection';

const emailSchema = z.string().trim().toLowerCase().max(254).email();
const discoveryBody = z.object({ email: emailSchema }).strict();
const selectBody = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.:-]+$/),
    email: emailSchema.optional(),
    desktop: desktopFlowSchema.optional(),
  })
  .strict();

const readBody = async (request: Request, signal: AbortSignal) => {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new DiscoveryError('INVALID_REQUEST', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new DiscoveryError('INVALID_REQUEST', 400);
  const abort = () => {
    void reader.cancel().catch(() => console.warn('TENANT_DISCOVERY_BODY_CANCEL_FAILED'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    let length = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) {
        await reader.cancel();
        throw new DiscoveryError('INVALID_REQUEST', 400);
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DiscoveryError('INVALID_REQUEST', 400);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
};
const response = (body: unknown, status = 200, extra?: Record<string, string>) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...extra },
  });

/** Request validation and Redis admission precede every platform and business DB read. */
export const handleTenantDiscovery = async (
  request: Request,
  kind: 'discovery' | 'select' | 'desktop-handoff',
) => {
  try {
    const appOrigin = new URL(appEnv.APP_URL).origin;
    const host = request.headers.get('host') ?? new URL(request.url).host;
    if (host.toLowerCase() !== new URL(appOrigin).host.toLowerCase() || request.method !== 'POST')
      throw new DiscoveryError('NOT_FOUND', 404);
    if (kind === 'select' && request.headers.get('origin') !== appOrigin)
      throw new DiscoveryError('ORIGIN_REJECTED', 403);
    return await withDiscoveryDeadline(request.signal, async (signal) => {
      const raw = await readBody(request, signal);
      const parsed = (
        kind === 'discovery' ? discoveryBody : kind === 'select' ? selectBody : desktopFlowSchema
      ).safeParse(raw);
      if (!parsed.success) throw new DiscoveryError('INVALID_REQUEST', 400);
      const body = parsed.data;
      if (kind === 'desktop-handoff') {
        const flow = desktopFlowSchema.parse(body);
        return response(await readDesktopHandoff({ headers: request.headers, flow, signal }));
      }
      if (kind === 'select' && 'desktop' in body && body.desktop) {
        const result = await selectDesktopTenant({
          headers: request.headers,
          flow: body.desktop,
          tenantId: body.id,
          signal,
        });
        return response(result, 200, {
          'Set-Cookie': serializeTenantCookie(body.id, appEnv.APP_URL),
          'Cache-Control': 'private, no-store',
        });
      }
      const email = 'email' in body ? body.email : undefined;
      const retryAfter = await redisService.tenantDiscovery.admit(
        kind,
        discoveryIpBucket(request.headers),
        email ? emailFingerprint(email) : undefined,
      );
      if (retryAfter !== null) throw new DiscoveryError('RATE_LIMITED', 429, retryAfter);
      return discoveryAdmission.run(signal, async () => {
        const candidates = await loadDiscoveryCandidates(
          signal,
          kind === 'select' && 'id' in body ? body.id : undefined,
        );
        signal.throwIfAborted();
        if (kind === 'discovery') {
          const found = await withLookupClient(signal, (client) =>
            queryTenantMembership(client, candidates, email!),
          );
          return response({ tenants: discoveryResults(found) });
        }
        const candidate = candidates.find((c) => c.id === ('id' in body ? body.id : undefined));
        if (!candidate) throw new DiscoveryError('TENANT_NOT_AVAILABLE', 404);
        await withLookupClient(signal, (client) => verifyCandidateObjects(client, [candidate]));
        signal.throwIfAborted();
        const url = new URL(`${candidate.activeUrl}/signin`);
        if (email) url.searchParams.set('email', email);
        return response({ url: url.href }, 200, {
          'Set-Cookie': serializeTenantCookie(candidate.id, appEnv.APP_URL),
          'Cache-Control': 'private, no-store',
        });
      });
    });
  } catch (error) {
    if (error instanceof DiscoveryError)
      return response(
        { code: error.code },
        error.status,
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined,
      );
    // Never serialize/log pg messages, DSNs, request URLs or email-bearing input.
    console.error('TENANT_DISCOVERY_UNAVAILABLE');
    return response({ code: 'TENANT_DISCOVERY_UNAVAILABLE' }, 503);
  }
};
