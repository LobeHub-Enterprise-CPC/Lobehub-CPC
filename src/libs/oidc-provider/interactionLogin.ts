import { getTenantAuth } from '@/auth';

export interface TenantLoginSession {
  /** Display fields of the session user, for naming the account when the user row is unreadable. */
  avatar?: string;
  email?: string;
  name?: string;
  /** Better Auth session creation time, in whole Unix seconds (the OIDC `auth_time`). */
  ts: number;
  userId: string;
}

export interface TenantSessionRead {
  /** Absent when the browser holds no valid tenant session. */
  session?: TenantLoginSession;
  /** Every Set-Cookie Better Auth produced while reading; it must ride on the response. */
  setCookies: string[];
}

export type InteractionLoginResult =
  | { error: 'login_required'; error_description: string }
  | { login: { accountId: string; remember: true; ts: number } };

/**
 * The session was read but cannot be used. It carries the Set-Cookie headers Better Auth had
 * already produced, so the caller can still put them on whatever response it sends.
 */
export class TenantSessionReadError extends Error {
  readonly setCookies: string[];

  constructor(message: string, setCookies: string[]) {
    super(message);
    this.name = 'TenantSessionReadError';
    this.setCookies = setCookies;
  }
}

/** Set-Cookie headers a failed {@link readTenantSession} had already obtained, if any. */
export const setCookiesOfReadError = (error: unknown): string[] =>
  error instanceof TenantSessionReadError ? error.setCookies : [];

/**
 * Read the browser's tenant session. A failure is thrown, never returned as "no session": the
 * caller decides what an unreadable session means, and it must not be mistaken for a sign-out.
 * A failure after Better Auth produced cookies is a {@link TenantSessionReadError} holding them.
 */
export const readTenantSession = async (headers: Headers): Promise<TenantSessionRead> => {
  const { headers: authHeaders, response } = await (
    await getTenantAuth()
  ).api.getSession({ headers, returnHeaders: true });
  const setCookies = authHeaders.getSetCookie();
  if (!response?.user) return { setCookies };

  const createdAt = new Date(response.session.createdAt).getTime();
  if (!Number.isFinite(createdAt)) {
    throw new TenantSessionReadError('SESSION_CREATED_AT_INVALID', setCookies);
  }

  const { id, image, email, name } = response.user;
  return {
    session: {
      avatar: image || undefined,
      email: email || undefined,
      name: name || undefined,
      ts: Math.floor(createdAt / 1000),
      userId: id,
    },
    setCookies,
  };
};

/**
 * Whether the provider asks only because the browser has no usable provider session for the
 * tenant account: it has none (`no_session`), or the one it has belongs to another account or to
 * a tenant session that ended (`tenant_session_mismatch`). Both are answered by logging in with
 * the tenant session the browser holds. Anything else (`login_prompt`, `max_age`,
 * `id_token_hint`, `claims_id_token_sub_value`, `essential_acr(s)`) asks for a fresh or different
 * authentication that this server cannot perform on its own.
 */
export const isSessionOnlyReasons = (reasons: readonly string[] | undefined): boolean =>
  !!reasons?.length &&
  reasons.every((reason) => reason === 'no_session' || reason === 'tenant_session_mismatch');

/**
 * Result that ends a login interaction with the browser's existing tenant session.
 *
 * OIDC Core 3.1.2.6: an OP that cannot re-authenticate the End-User must answer `login_required`.
 */
export const loginInteractionResult = (
  reasons: readonly string[] | undefined,
  session: TenantLoginSession,
): InteractionLoginResult =>
  isSessionOnlyReasons(reasons)
    ? { login: { accountId: session.userId, remember: true, ts: session.ts } }
    : {
        error: 'login_required',
        error_description: 'Re-authentication is not supported',
      };
