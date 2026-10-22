import { z } from 'zod';

import { redisService } from '@/server/services/redis';

import { loadAccountOrganization, loadAccountOrganizations } from './account';
import {
  accountCookieAvailable,
  accountCookieValue,
  clearAccountCookie,
  readAccountMemory,
} from './accountCookie';
import { discoveryAdmission, withDiscoveryDeadline } from './admission';
import { DiscoveryError } from './errors';
import { assertDiscoveryRequest, readDiscoveryBody, tenantSelectionIdSchema } from './http';
import { serializeTenantCookie, SESSION_ENTRY_PATH } from './navigation';
import { discoveryIpBucket, emailFingerprint } from './protection';
import { discoveryResults } from './query';

export type TenantAccountAction = 'account' | 'forget' | 'select';

const emptyBody = z.object({}).strict();
const selectBody = z.object({ id: tenantSelectionIdSchema }).strict();

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};

const json = (body: unknown, status = 200, extra?: Record<string, string>) =>
  Response.json(body, { status, headers: { ...PRIVATE_HEADERS, ...extra } });

const empty = (extra?: Record<string, string>) =>
  new Response(null, { status: 204, headers: { ...PRIVATE_HEADERS, ...extra } });

const failure = (error: unknown) => {
  if (error instanceof DiscoveryError)
    return json(
      { code: error.code },
      error.status,
      error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined,
    );
  // Never serialize/log email-bearing input, DSNs or raw database messages.
  console.error('TENANT_DISCOVERY_UNAVAILABLE');
  return json({ code: 'TENANT_DISCOVERY_UNAVAILABLE' }, 503);
};

/**
 * The remembered-account endpoints. They share the finder's platform host, same-origin and
 * deadline rules; the cookie is the only identity, and every response stays out of caches.
 */
export const handleTenantAccount = async (request: Request, action: TenantAccountAction) => {
  try {
    const appOrigin = assertDiscoveryRequest(request, { requireOrigin: true });
    return await withDiscoveryDeadline(request.signal, async (signal) => {
      const raw = await readDiscoveryBody(request, signal);
      let selectedId: string | undefined;
      if (action === 'select') {
        const parsed = selectBody.safeParse(raw);
        if (!parsed.success) throw new DiscoveryError('INVALID_REQUEST', 400);
        selectedId = parsed.data.id;
      } else if (!emptyBody.safeParse(raw).success) {
        throw new DiscoveryError('INVALID_REQUEST', 400);
      }
      const rawCookie = accountCookieValue(request.headers, appOrigin);
      const memory = rawCookie ? readAccountMemory(rawCookie) : null;
      const clearing =
        action === 'forget'
          ? { 'Set-Cookie': clearAccountCookie(appOrigin) }
          : rawCookie && accountCookieAvailable()
            ? { 'Set-Cookie': clearAccountCookie(appOrigin) }
            : undefined;

      const retryAfter = await redisService.tenantDiscovery.admit(
        'account',
        discoveryIpBucket(request.headers),
        action !== 'forget' && memory ? emailFingerprint(memory.email) : undefined,
      );
      if (retryAfter !== null) throw new DiscoveryError('RATE_LIMITED', 429, retryAfter);

      if (action === 'forget') return empty(clearing);

      if (!memory)
        return action === 'account'
          ? empty(clearing)
          : json({ code: 'ACCOUNT_MEMORY_MISSING' }, 409, clearing);

      if (action === 'account') {
        const organizations = await discoveryAdmission.run(signal, () =>
          loadAccountOrganizations(signal, memory.email),
        );
        if (!organizations.length) return empty();
        const results = discoveryResults(organizations);
        return json({
          email: memory.email,
          lastTenantId: results.some(({ id }) => id === memory.tenantId) ? memory.tenantId : null,
          organizations: results,
        });
      }

      const id = selectedId;
      if (!id) throw new DiscoveryError('INVALID_REQUEST', 400);
      const organization = await discoveryAdmission.run(signal, () =>
        loadAccountOrganization(signal, memory.email, id),
      );
      return json({ url: `${organization.activeUrl}${SESSION_ENTRY_PATH}?signin=1` }, 200, {
        'Set-Cookie': serializeTenantCookie(organization.id, appOrigin),
      });
    });
  } catch (error) {
    return failure(error);
  }
};
