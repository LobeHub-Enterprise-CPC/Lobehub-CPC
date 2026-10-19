import { runWithTenantScope } from '@lobechat/database/tenant';
import type { NextRequest } from 'next/server';

import { getTenantAuth } from '@/auth';
import { endpointHosts } from '@/server/modules/Tenant/endpoints';
import { tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import { routingUnavailableReasonOf } from '@/server/modules/Tenant/routingErrors';
import { getTenantRuntime } from '@/server/modules/Tenant/runtime';
import {
  lookupEntrySession,
  SESSION_ENTRY_PATH,
} from '@/server/services/tenantDiscovery/navigation';

import { navigationRedirect } from '../navigationRedirect';
import { navigationUnavailable } from './responses';
import type { TenantMiddlewareDeps } from './types';

/**
 * The session entry of an active endpoint: asks the remembered organization whether this
 * browser holds a valid session there and answers with a navigation only. Routing has already
 * required a top-level document GET and kept the visit out of the memory cookie. Every target
 * comes from the directory (`activeUrl`) or the platform URL, never from the request.
 *
 * - valid session: the organization root.
 * - no session (missing, expired, revoked): the organization finder; cookies Better Auth
 *   clears for a dead session ride on this response.
 * - the organization refuses admission (frozen, offline, expired, not activated): its root,
 *   whose page explains it. The session is not judged then; there is no scope to read it in.
 * - the organization vanished: the organization finder.
 * - anything else (opening the tenant database, building auth, reading the session): 503
 *   that retries this entry. A failure is never read as "no session".
 */
export const sessionEntry = async (
  deps: TenantMiddlewareDeps,
  req: NextRequest,
  headers: Headers,
  route: { activeUrl: string; slug: string },
  onDefaultTenantPage: (tenantId: string | undefined) => void,
) => {
  const root = `${route.activeUrl}/#`;
  const finder = `${new URL(endpointHosts().appUrl).origin}/?switch=1#`;
  const entryUrl = `${route.activeUrl}${SESSION_ENTRY_PATH}`;
  const unavailable = (reason: string) => {
    console.warn('TENANT_SESSION_ENTRY_UNAVAILABLE', { reason });
    return navigationUnavailable(deps, req, `${entryUrl}#`);
  };

  let entered;
  try {
    entered = await getTenantRuntime().enterSlug(route.slug);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'TENANT_NOT_FOUND') {
      console.warn('TENANT_NOT_FOUND', { slug: route.slug });
      onDefaultTenantPage(undefined);
      return navigationRedirect(finder);
    }
    // Only an explicit admission refusal is shown as the organization's own page; a runtime or
    // database failure while opening the scope, or anything unrecognized, is retryable.
    if (tenantGateErrorOf(error)?.source === 'admission') return navigationRedirect(root);
    return unavailable(routingUnavailableReasonOf(error));
  }

  const { release, scope } = entered;
  let lookup;
  try {
    // Persisted state decides (see `lookupEntrySession`): no cookie cache, no refresh, and this
    // instance's own cache cookie hidden because Better Auth decodes it before it honours
    // `disableCookieCache`. The cookie names and attributes come from the tenant's auth
    // instance, never a fixed pattern.
    lookup = await runWithTenantScope(scope, async () =>
      lookupEntrySession(await getTenantAuth(), req.headers),
    );
  } catch {
    return unavailable('SESSION_LOOKUP_FAILED');
  } finally {
    await release().catch(() => console.warn('TENANT_SESSION_ENTRY_RELEASE_FAILED'));
  }

  const response = navigationRedirect(lookup.hasSession ? root : finder);
  for (const cookie of lookup.setCookies) response.headers.append('set-cookie', cookie);
  return response;
};
