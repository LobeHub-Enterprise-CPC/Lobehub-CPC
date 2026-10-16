import { currentTenantScope } from '@lobechat/database/tenant';
import { headers } from 'next/headers';

import { isTrustedClientEnabled } from './config';
import { TrustedClientIdentityError } from './errors';
import { type TrustedClientUserInfo } from './index';
import { resolveTrustedClientIdentity } from './resolveIdentity';

/**
 * Get user info from the current session for trusted client authentication
 *
 * @returns User info, or undefined when there is genuinely no session (the
 *   lookup answered "nobody is signed in")
 * @throws {TrustedClientIdentityError} `SESSION_UNAVAILABLE` when the lookup
 *   itself failed (tenant or not), and when there is a session but its Market
 *   identity cannot be assembled — see `resolveTrustedClientIdentity`
 */
export const getSessionUser = async (): Promise<TrustedClientUserInfo | undefined> => {
  // The session itself is tenant-scoped, so without a scope "no session" would
  // be an artifact of the missing tenant rather than a signed-out user.
  if (isTrustedClientEnabled() && !currentTenantScope()) {
    throw new TrustedClientIdentityError('TENANT_REQUIRED');
  }

  let user: { email: string; id: string; name?: string | null };

  try {
    // Dynamic import to avoid validator ESM/CJS issue during sitemap generation
    const { auth } = await import('@/auth');
    const headersList = await headers();
    const session = await auth.api.getSession({
      headers: headersList,
    });

    // No session is "not signed in", not an identity failure.
    if (!session?.user?.id || !session?.user?.email) return undefined;

    user = session.user;
  } catch {
    // A lookup that throws does not say the visitor is signed out. Returning
    // undefined here would let a signed-in request go out to Market with no
    // credentials, which lands in the default instance. Neither the error nor
    // its message is chained: it can carry connection details.
    throw new TrustedClientIdentityError('SESSION_UNAVAILABLE');
  }

  return resolveTrustedClientIdentity({
    email: user.email,
    name: user.name || undefined,
    userId: user.id,
  });
};
