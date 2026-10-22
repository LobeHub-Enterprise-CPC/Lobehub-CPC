import debug from 'debug';
import { type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { OAuthHandoffModel } from '@/database/models/oauthHandoff';
import { serverDB } from '@/database/server';
import { describeError } from '@/libs/oidc-provider/safe-log';
import { tenantPublicPath } from '@/server/modules/Tenant/callbackUrl';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { after } from '@/server/utils/scheduleAfterResponse';

const log = debug('lobe-oidc:callback:desktop');

const errorPathname = '/oauth/callback/error';

// RFC 6749 / OIDC codes the provider (or the consent card's "deny") sends back without a `code`.
// Only these literals are forwarded: error_description and any other value are never echoed.
const OAUTH_ERROR_REASONS = new Set([
  'access_denied',
  'consent_required',
  'interaction_required',
  'login_required',
]);

const redirectTo = (pathname: string, params?: Record<string, string>) => {
  // The result pages are SPA routes under the tenant's active entry, like the redirect_uri itself.
  const location = tenantPublicPath(
    params ? `${pathname}?${new URLSearchParams(params)}` : pathname,
  );
  // The error page URL can embed the failure text, so the target is not logged.
  log('Redirecting to %s', pathname);
  return new NextResponse(null, { headers: { location }, status: 307 });
};

const handleGet = async (req: NextRequest) => {
  try {
    const searchParams = req.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state'); // This `state` is the handoff ID

    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
      log('Missing code or state in form data');

      const oauthError = searchParams.get('error');
      const reason = oauthError && OAUTH_ERROR_REASONS.has(oauthError) ? oauthError : undefined;

      return redirectTo(errorPathname, { reason: reason ?? 'invalid_request' });
    }

    log('Received OIDC callback');

    // The 'client' is 'desktop' because this redirect_uri is for the desktop client.
    const client = 'desktop';
    const payload = { code, state };
    const id = state;

    const authHandoffModel = new OAuthHandoffModel(serverDB);
    await authHandoffModel.create({ client, id, payload });
    log('Handoff record created successfully');

    // cleanup expired
    after(async () => {
      const cleanedCount = await authHandoffModel.cleanupExpired();

      log('Cleaned up %d expired handoff records', cleanedCount);
    });

    return redirectTo('/oauth/callback/success');
  } catch (error) {
    log('Error in OIDC callback: %s', describeError(error));

    // The failure text can embed the stored values (code, handoff id): only a code travels.
    return redirectTo(errorPathname, { reason: 'internal_error' });
  }
};

export const GET = withTenantRequest(handleGet);
