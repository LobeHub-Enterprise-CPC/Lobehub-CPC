import { type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth/types';

export const configureBusinessAuth = <T extends BetterAuthOptions>(options: T): T => options;

/**
 * Better Auth plugins contributed by the distribution, merged ahead of the
 * built-in ones in `src/auth.ts`.
 *
 * The slot exists because access policy is a property of the deployment, not of
 * the product: who may register, and on what evidence, is decided by whoever
 * runs the install. The built-in `emailWhitelist` covers the common case from
 * `AUTH_ALLOWED_EMAILS`, but an env var is a poor fit once the answer changes
 * during the deployment's life — every edit needs a config change and a
 * restart, and the whole list is rewritten to add one address. A distribution
 * that keeps its list in a database, a directory, or an upstream IdP has
 * nowhere to say so without this.
 *
 * Empty by default: the built-in plugins are the whole policy unless a
 * distribution adds to it.
 */
export const businessAuthPlugins: BetterAuthPlugin[] = [];

export const managedBusinessSSO = false;
export const getBusinessAuthOptions = async (
  _request: Request,
): Promise<BetterAuthOptions | null> => null;
export const listBusinessSSOProviders = async (): Promise<
  Array<{
    id: string;
    displayName: string;
    logoUrl: string | null;
    protocol: string;
  }>
> => [];

/** Distribution seam: current account authorization for non-session credentials. */
export const assertBusinessUserAccess = async (_db: unknown, _userId: string): Promise<void> => {};
export const isBusinessAuthorizationError = (
  error: unknown,
): error is Error & { code: string; status: 403 | 503 } =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  ['PLATFORM_ACCESS_DENIED', 'AUTHORIZATION_UNAVAILABLE'].includes(String(error.code));
export const withBusinessIdentityUpdate = async <T, D>(
  db: D,
  _userId: string,
  update: (tx: D) => Promise<T>,
): Promise<T> => update(db);
