import { acceptanceIdFromReviewResource } from '@lobechat/const';
import debug from 'debug';
import { type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { isAcceptanceReviewClient } from '@/libs/oidc-provider/acceptanceReview';
import {
  loginInteractionResult,
  readTenantSession,
  setCookiesOfReadError,
} from '@/libs/oidc-provider/interactionLogin';
import { describeError } from '@/libs/oidc-provider/safe-log';
import { buildTenantPublicUrl } from '@/server/modules/Tenant/callbackUrl';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { resolveReviewAccess } from '@/server/services/acceptanceReview/access';
import { OIDCService } from '@/server/services/oidc';

const log = debug('lobe-oidc:consent');

const canReview = async (userId: string | null | undefined, resource: unknown) => {
  const acceptanceId = acceptanceIdFromReviewResource(
    Array.isArray(resource) ? resource[0] : resource,
  );
  if (!userId || !acceptanceId) return false;
  return Boolean(await resolveReviewAccess(await getServerDB(), userId, acceptanceId));
};

/**
 * A form posted from our own page. The consent page is served with `Referrer-Policy: no-referrer`,
 * so its POST carries `Origin: null`; that value is only trusted together with
 * `Sec-Fetch-Site: same-origin`. Any other `Sec-Fetch-Site` is refused even when Origin matches.
 */
const isSameOriginSubmission = (headers: Headers, expectedOrigin: string) => {
  const site = headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;

  const origin = headers.get('origin');
  if (origin === null || origin === 'null') return site === 'same-origin';
  return origin === expectedOrigin;
};

const rejectJson = (status: number, body: Record<string, string>) =>
  NextResponse.json(body, { status });

async function handlePost(request: NextRequest) {
  log('Received POST request for /oidc/consent');

  // The decision is made with the browser's cookies, so only the organization's own pages may
  // submit it. Checked before anything is read or written.
  if (!isSameOriginSubmission(request.headers, new URL(buildTenantPublicUrl('/')).origin)) {
    return rejectJson(403, { error: 'forbidden', error_description: 'Cross-origin request' });
  }

  // Cookies Better Auth sets while reading the session ride on whichever response follows,
  // including a failure after they were obtained.
  let sessionCookies: string[] = [];
  const withSessionCookies = (response: NextResponse) => {
    for (const cookie of sessionCookies) response.headers.append('set-cookie', cookie);
    return response;
  };

  try {
    const formData = await request.formData();
    const consent = formData.get('consent') as string;
    const uid = formData.get('uid') as string;

    log('POST /oauth/consent - choice=%s', consent);

    const oidcService = await OIDCService.initialize();

    let details;
    try {
      details = await oidcService.getInteractionDetails(uid);
      log(
        'Interaction details found - prompt=%s, client=%s',
        details.prompt.name,
        details.params.client_id,
      );
    } catch (error) {
      log('Error: Interaction details not found - %s', describeError(error));
      // The provider session behind this interaction ended or was replaced (signed out, or another
      // account signed in); oidc-provider raises SessionNotFound for it.
      if (error instanceof Error && error.name === 'SessionNotFound') {
        return withSessionCookies(rejectJson(400, { error: 'session_changed' }));
      }
      if (error instanceof Error && error.message.includes('interaction session not found')) {
        return NextResponse.json(
          {
            error: 'invalid_request',
            error_description:
              'Authorization session expired or invalid, please restart the authorization flow',
          },
          { status: 400 },
        );
      }
      throw error;
    }

    if (details.uid !== uid) {
      return rejectJson(400, {
        error: 'invalid_request',
        error_description:
          'Authorization session expired or invalid, please restart the authorization flow',
      });
    }

    const { prompt } = details;
    // Only the two prompts this endpoint knows how to answer; anything else changes nothing.
    const unsupported = () =>
      rejectJson(400, {
        error: 'unsupported_interaction',
        error_description: 'This interaction cannot be answered here',
      });
    if (prompt.name !== 'login' && prompt.name !== 'consent') return unsupported();

    let result;

    if (consent === 'accept') {
      log(`User accepted the request`);
      let read;
      try {
        read = await readTenantSession(request.headers);
      } catch (error) {
        sessionCookies = setCookiesOfReadError(error);
        throw error;
      }
      sessionCookies = read.setCookies;
      const { session } = read;

      if (prompt.name === 'login') {
        log(`Handling 'login' prompt`);
        if (!session) {
          return withSessionCookies(
            rejectJson(401, {
              error: 'login_required',
              error_description: 'No signed-in session',
            }),
          );
        }
        result = loginInteractionResult(details.prompt.reasons, session);
      } else if (prompt.name === 'consent') {
        log(`Handling 'consent' prompt`);

        // The consent card was shown for the account the provider session holds; a grant is
        // never written for any other account, and no existing grant is touched on a mismatch.
        if (!session || session.userId !== details.session?.accountId) {
          return withSessionCookies(rejectJson(400, { error: 'session_changed' }));
        }
        const { userId } = session;

        // 1. Get necessary IDs
        const clientId = details.params.client_id as string;

        if (
          isAcceptanceReviewClient(clientId) &&
          !(await canReview(userId, details.params.resource))
        ) {
          const denied = await oidcService.getInteractionResult(uid, {
            error: 'access_denied',
            error_description: 'No access to this acceptance',
          });
          const { pathname, search, hash } = new URL(denied);
          return withSessionCookies(
            new NextResponse(null, {
              headers: { location: `${pathname}${search}${hash}` },
              status: 303,
            }),
          );
        }

        // 2. Find or create Grant object
        const grant = await oidcService.findOrCreateGrants(userId, clientId, details.grantId);

        // 3. Add user-consented scopes and claims to Grant object
        //    This information is typically in details.prompt.details
        const missingOIDCScope = (prompt.details.missingOIDCScope as string[]) || [];
        if (missingOIDCScope) {
          grant.addOIDCScope(missingOIDCScope.join(' '));
          log('Added OIDC scopes to grant: %s', missingOIDCScope.join(' '));
        }
        const missingOIDCClaims = (prompt.details.missingOIDCClaims as string[]) || [];
        if (missingOIDCClaims) {
          grant.addOIDCClaims(missingOIDCClaims);
          log('Added OIDC claims to grant: %s', missingOIDCClaims.join(' '));
        }

        const missingResourceScopes =
          (prompt.details.missingResourceScopes as Record<string, string[]>) || {};
        if (missingResourceScopes) {
          for (const [indicator, scopes] of Object.entries(missingResourceScopes)) {
            grant.addResourceScope(indicator, scopes.join(' '));
            log('Added resource scopes for %s to grant: %s', indicator, scopes.join(' '));
          }
        }
        // If RAR (Rich Authorization Requests) is used, it also needs to be added to grant
        // if (prompt.details.rar) {
        //   prompt.details.rar.forEach(detail => grant.addRar(detail));
        // }

        // 4. Save Grant object to get its jti (grantId)
        const newGrantId = await grant.save();
        log('Saved grant');

        // 5. Prepare result containing grantId
        result = { consent: { grantId: newGrantId } };

        log('Consent result prepared with grantId');
      } else {
        return unsupported();
      }
      log('User %s the authorization', consent);
    } else {
      log('User rejected the request');
      result = {
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      };
      log('User %s the authorization', consent);
    }

    const internalRedirectUrlString = await oidcService.getInteractionResult(uid, result);

    // The gateway rewrites Host on the way to the origin, so the server cannot tell which
    // public origin the browser is on. A relative Location keeps it on the origin that holds
    // the interaction cookies.
    const { pathname, search, hash } = new URL(internalRedirectUrlString);
    const location = `${pathname}${search}${hash}`;

    log('Redirecting to the provider resume path');
    return withSessionCookies(new NextResponse(null, { headers: { location }, status: 303 }));
  } catch (error) {
    console.error('Error processing consent: %s', describeError(error));
    return withSessionCookies(
      NextResponse.json(
        {
          error: 'server_error',
          error_description: 'Error processing consent',
        },
        { status: 500 },
      ),
    );
  }
}

export const POST = withTenantRequest(handlePost);
