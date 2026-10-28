import debug from 'debug';
import { type NextRequest, NextResponse } from 'next/server';

import { authEnv } from '@/envs/auth';
import { DESKTOP_CLIENT_ID } from '@/libs/oidc-provider/desktopClient';
import {
  loginInteractionResult,
  readTenantSession,
  setCookiesOfReadError,
  type TenantSessionRead,
} from '@/libs/oidc-provider/interactionLogin';
import { describeError } from '@/libs/oidc-provider/safe-log';
import { buildTenantPublicUrl, tenantPublicPath } from '@/server/modules/Tenant/callbackUrl';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { OIDCService } from '@/server/services/oidc';

const log = debug('lobe-oidc:interaction-login');

const NO_CACHE_HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
} as const;

const respond = (
  status: number,
  { location, setCookies = [] }: { location?: string; setCookies?: string[] } = {},
) => {
  const headers = new Headers(NO_CACHE_HEADERS);
  if (location) headers.set('location', location);
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new NextResponse(null, { headers, status });
};

const redirect = (location: string, setCookies?: string[]) =>
  respond(303, { location, setCookies });

/**
 * Server-side bridge for a `login` interaction.
 *
 * `interactions.url` sends a login prompt here instead of the SPA consent page, so a browser
 * without a sign-in goes straight to the sign-in page, and a browser that already has a tenant
 * session finishes the login step without a screen. It never creates a Grant or submits consent;
 * the consent step that follows stays with the consent page.
 */
async function handleGet(request: NextRequest, props: { params: Promise<{ uid: string }> }) {
  if (!authEnv.ENABLE_OIDC) return respond(404);

  // Only a top-level navigation may drive this route; a subresource or fetch gets no side effect.
  const dest = request.headers.get('sec-fetch-dest');
  if (dest !== null && dest !== 'document') return respond(400);

  const { uid } = await props.params;
  const hl = new URL(request.url).searchParams.get('hl');
  const withHl = (path: string) => (hl ? `${path}?${new URLSearchParams({ hl })}` : path);
  // Every fallback is the consent page of this interaction, which reports the actual problem.
  const consentPage = (setCookies?: string[]) =>
    redirect(tenantPublicPath(withHl(`/oauth/consent/${encodeURIComponent(uid)}`)), setCookies);

  let oidcService: OIDCService;
  let details;
  try {
    oidcService = await OIDCService.initialize();
    details = await oidcService.getInteractionDetails(uid);
  } catch (error) {
    log('Interaction not readable: %s', describeError(error));
    return consentPage();
  }
  if (details.uid !== uid || details.prompt.name !== 'login') return consentPage();

  let read: TenantSessionRead;
  try {
    read = await readTenantSession(request.headers);
  } catch (error) {
    // An unreadable session is not a missing one: sending the user to sign in could loop.
    log('Session not readable: %s', describeError(error));
    return consentPage(setCookiesOfReadError(error));
  }
  const { session, setCookies } = read;

  if (!session) {
    const callbackUrl = buildTenantPublicUrl(
      withHl(`/oidc/interaction/${encodeURIComponent(uid)}/login`),
    );
    const signIn = new URL(buildTenantPublicUrl('/signin'));
    signIn.searchParams.set('callbackUrl', callbackUrl);
    if (hl) signIn.searchParams.set('hl', hl);
    return redirect(signIn.href, setCookies);
  }

  const reasons = details.prompt.reasons as string[] | undefined;
  const desktop = details.params.client_id === DESKTOP_CLIENT_ID;
  const result = loginInteractionResult(reasons, session);
  // Other clients keep the "continue as" card; only a refusal to re-authenticate applies to all.
  if (!desktop && 'login' in result) return consentPage(setCookies);

  try {
    const resume = new URL(await oidcService.getInteractionResult(uid, result));
    return redirect(`${resume.pathname}${resume.search}${resume.hash}`, setCookies);
  } catch (error) {
    log('Interaction result not accepted: %s', describeError(error));
    return consentPage(setCookies);
  }
}

export const GET = withTenantRequest(handleGet);

export const HEAD = withTenantRequest(() => {
  const response = respond(405);
  response.headers.set('allow', 'GET');
  return response;
});
