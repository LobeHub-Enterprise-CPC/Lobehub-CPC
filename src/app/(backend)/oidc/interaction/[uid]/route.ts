import { acceptanceIdFromReviewResource } from '@lobechat/const';
import debug from 'debug';
import { type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { UserModel } from '@/database/models/user';
import { authEnv } from '@/envs/auth';
import { isAcceptanceReviewClient } from '@/libs/oidc-provider/acceptanceReview';
import {
  readTenantSession,
  setCookiesOfReadError,
  type TenantLoginSession,
} from '@/libs/oidc-provider/interactionLogin';
import { describeError } from '@/libs/oidc-provider/safe-log';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { resolveReviewAccess } from '@/server/services/acceptanceReview/access';
import { OIDCService } from '@/server/services/oidc';
import type { OidcInteractionDetailsResponse, OidcInteractionErrorResponse } from '@/types/oidc';

const log = debug('lobe-oidc:interaction');

// Errors that tell the page the browser's sign-in, not the interaction, is the issue.
type DetailsErrorBody = Omit<OidcInteractionErrorResponse, 'error'> & {
  error: OidcInteractionErrorResponse['error'] | 'session_changed' | 'session_unavailable';
};

// The title is only revealed once the signed-in reviewer may read the acceptance.
const acceptanceReviewOf = async (
  resource: unknown,
  userId: string,
): Promise<OidcInteractionDetailsResponse['acceptanceReview']> => {
  const acceptanceId = acceptanceIdFromReviewResource(
    Array.isArray(resource) ? resource[0] : resource,
  );
  if (!acceptanceId) return { allowed: false };
  const access = await resolveReviewAccess(await getServerDB(), userId, acceptanceId);
  if (!access) return { allowed: false };
  return {
    allowed: true,
    title: access.acceptance.metadata?.title || access.acceptance.requirement || undefined,
  };
};

// The card names the account the provider session holds. The caller has already checked that it
// is still the account signed in to this browser. The tenant user row is the source; the session's
// own user fields cover a failed or empty lookup. Without a name or an email nothing identifies the
// account, so the card gets none rather than an empty block.
const accountOf = async (
  session: TenantLoginSession,
): Promise<OidcInteractionDetailsResponse['account']> => {
  let stored: { avatar?: string; email?: string; name?: string } = {};
  try {
    const user = await UserModel.findById(await getServerDB(), session.userId);
    if (user) {
      stored = {
        avatar: user.avatar || undefined,
        email: user.email || undefined,
        name: user.fullName || user.username || undefined,
      };
    }
  } catch (error) {
    log('Account lookup failed, using the session user: %s', describeError(error));
  }

  const name = stored.name ?? session.name;
  const email = stored.email ?? session.email;
  if (!name && !email) return undefined;
  return { avatar: stored.avatar ?? session.avatar, email, name };
};

async function handleGet(request: NextRequest, props: { params: Promise<{ uid: string }> }) {
  if (!authEnv.ENABLE_OIDC) {
    log('OIDC is not enabled');
    return new NextResponse(null, { status: 404 });
  }

  const { uid } = await props.params;
  log('Received GET request for /oidc/interaction');

  // Cookies Better Auth sets while reading the session ride on whichever response follows.
  let sessionCookies: string[] = [];
  const withSessionCookies = (response: NextResponse) => {
    for (const cookie of sessionCookies) response.headers.append('set-cookie', cookie);
    return response;
  };

  try {
    const oidcService = await OIDCService.initialize();
    const details = await oidcService.getInteractionDetails(uid);

    if (details.uid !== uid) {
      return NextResponse.json<OidcInteractionErrorResponse>(
        { error: 'session_invalid' },
        { status: 400 },
      );
    }

    log(
      'Interaction details found - prompt=%s, client=%s',
      details.prompt.name,
      details.params.client_id,
    );

    if (details.prompt.name !== 'consent' && details.prompt.name !== 'login') {
      return NextResponse.json<OidcInteractionErrorResponse>(
        { error: 'unsupported_interaction', promptName: details.prompt.name },
        { status: 409 },
      );
    }

    // A consent card is only shown for the account the provider session holds, and only while that
    // account is still the one signed in to this browser.
    let session: TenantLoginSession | undefined;
    if (details.prompt.name === 'consent') {
      try {
        const read = await readTenantSession(request.headers);
        sessionCookies = read.setCookies;
        session = read.session;
      } catch (error) {
        // An unreadable session is not a missing one: the page offers a retry, not a sign-in.
        sessionCookies = setCookiesOfReadError(error);
        log('Session not readable: %s', describeError(error));
        return withSessionCookies(
          NextResponse.json<DetailsErrorBody>({ error: 'session_unavailable' }, { status: 503 }),
        );
      }
      if (!session || session.userId !== details.session?.accountId) {
        return withSessionCookies(
          NextResponse.json<DetailsErrorBody>({ error: 'session_changed' }, { status: 400 }),
        );
      }
    }

    const clientId = (details.params.client_id as string) || 'unknown';
    const scopes = (details.params.scope as string)?.split(' ') || [];

    const clientMetadata = await oidcService.getConsentClientMetadata(clientId);
    const acceptanceReview =
      session && isAcceptanceReviewClient(clientId)
        ? await acceptanceReviewOf(details.params.resource, session.userId)
        : undefined;

    const account = session ? await accountOf(session) : undefined;

    return withSessionCookies(
      NextResponse.json<OidcInteractionDetailsResponse>({
        acceptanceReview,
        account,
        clientId,
        clientMetadata,
        prompt: details.prompt.name,
        redirectUri: details.params.redirect_uri as string,
        scopes,
        uid,
      }),
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : undefined;

    // The provider session this interaction is bound to ended or was replaced (signed out, or
    // another account signed in); oidc-provider raises SessionNotFound, not the "not found" text.
    if (error instanceof Error && error.name === 'SessionNotFound') {
      log('Interaction session changed: %s', describeError(error));
      return withSessionCookies(
        NextResponse.json<DetailsErrorBody>({ error: 'session_changed' }, { status: 400 }),
      );
    }

    if (errorMessage?.includes('interaction session not found')) {
      return withSessionCookies(
        NextResponse.json<OidcInteractionErrorResponse>(
          { error: 'session_invalid' },
          { status: 400 },
        ),
      );
    }

    log('Error handling OIDC interaction: %s', describeError(error));
    return withSessionCookies(
      NextResponse.json<OidcInteractionErrorResponse>({ error: 'server_error' }, { status: 500 }),
    );
  }
}

export const GET = withTenantRequest(handleGet);
