import type { IncomingHttpHeaders } from 'node:http';

import debug from 'debug';
import { interactionPolicy, type KoaContextWithOIDC } from 'oidc-provider';

import { getTenantAuth } from '@/auth';

import { DESKTOP_CLIENT_ID } from './desktopClient';
import { describeError } from './safe-log';

const { base, Check } = interactionPolicy;
const log = debug('lobe-oidc:interaction-policy');

/** The request headers of the provider's Node request, as the Fetch `Headers` Better Auth reads. */
const requestHeaders = (raw: IncomingHttpHeaders): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
};

/**
 * Whether the provider session no longer matches the tenant (Better Auth) session of this
 * browser. The two are independent: a tenant sign-out or an account switch elsewhere leaves the
 * provider session behind, and an authorization then skips login and reaches a consent that can
 * only be refused. A browser with no provider account is `no_session`'s business. An unreadable
 * tenant session asks to log in too: the login step reads it again and has its own fallback.
 */
const tenantSessionMismatch = async (ctx: KoaContextWithOIDC): Promise<boolean> => {
  const accountId = ctx.oidc.session?.accountId;
  if (!accountId) return false;

  try {
    // No refresh: a refresh would write a Set-Cookie that this check has no way to forward.
    const current = await (
      await getTenantAuth()
    ).api.getSession({
      headers: requestHeaders(ctx.req.headers),
      query: { disableRefresh: true },
    });
    return current?.user?.id !== accountId;
  } catch (error) {
    log('Tenant session not readable, asking to log in: %s', describeError(error));
    return true;
  }
};

/**
 * Create custom interaction policy
 */
export const createInteractionPolicy = () => {
  log('Creating custom interaction policy');
  const policy = base();

  log('Base policy details: %O', {
    promptNames: Array.from(policy.keys()),
    size: policy.length,
  });

  const loginPrompt = policy.get('login');
  log('Accessing login prompt from policy: %O', !!loginPrompt);

  if (loginPrompt) {
    log('Login prompt details: %O', {
      checks: Array.from(loginPrompt.checks.keys()),
      name: loginPrompt.name,
      requestable: loginPrompt.requestable,
    });
  } else {
    console.warn(
      "Could not find 'login' prompt in the base policy. Custom session check not applied.",
    );
    log('WARNING: login prompt not found in base policy');
  }

  // The provider session must belong to the account signed in to this tenant. Without this check
  // a provider session that outlived its tenant session (signed out, expired, revoked, or another
  // account signed in) skips login and ends in a consent that can never be answered.
  loginPrompt?.checks.add(
    new Check(
      'tenant_session_mismatch',
      'the provider session does not match the tenant session of the browser',
      'login_required',
      async (ctx) =>
        (await tenantSessionMismatch(ctx)) ? Check.REQUEST_PROMPT : Check.NO_NEED_TO_PROMPT,
    ),
  );

  // The desktop app asks for the user's explicit consent in every authorization transaction, not
  // only when `prompt=consent` is sent or a scope is missing. A transaction that already carries
  // a consent result (the resume after the consent card) is satisfied, so it never loops. The
  // error is explicit: checks added after construction do not inherit the prompt's default, and
  // `prompt=none` must answer `consent_required`.
  policy
    .get('consent')
    ?.checks.add(
      new Check(
        'desktop_explicit_consent',
        'the desktop client requires explicit End-User consent',
        'consent_required',
        (ctx) =>
          ctx.oidc.client?.clientId === DESKTOP_CLIENT_ID && !ctx.oidc.result?.consent
            ? Check.REQUEST_PROMPT
            : Check.NO_NEED_TO_PROMPT,
      ),
    );

  log('Custom interaction policy created successfully');
  return policy;
};
