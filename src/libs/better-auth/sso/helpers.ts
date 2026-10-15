import { type GenericOAuthConfig } from 'better-auth/plugins';

export const DEFAULT_OIDC_SCOPES = ['openid', 'email', 'profile'];

const createDiscoveryUrl = (issuer: string) => {
  const normalized = issuer.replace(/\/$/, '');
  return normalized.includes('/.well-known/')
    ? normalized
    : `${normalized}/.well-known/openid-configuration`;
};

const claim = (value: unknown) =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : undefined;

/**
 * Display name for a user whose identity provider may not send a `name` claim
 * (e.g. Clerk or Keycloak users without a first / last name): better-auth
 * rejects the sign-in with `name_is_missing` otherwise.
 * name -> given_name + family_name -> preferred_username -> nickname / username
 * / login -> email -> sub / id.
 */
export const resolveProfileName = (profile: Record<string, any>): string | undefined => {
  const composed = [claim(profile.given_name), claim(profile.family_name)]
    .filter(Boolean)
    .join(' ');

  return (
    claim(profile.name) ??
    (composed || undefined) ??
    claim(profile.preferred_username) ??
    claim(profile.nickname) ??
    claim(profile.username) ??
    claim(profile.login) ??
    claim(profile.email) ??
    claim(profile.sub) ??
    claim(profile.id)
  );
};

/**
 * `mapProfileToUser` that only fills in the name. better-auth merges the result
 * over the raw profile, so returning other keys (even `undefined`) would
 * overwrite the email, image and verification state it reads from there.
 */
export const mapProfileNameToUser: NonNullable<GenericOAuthConfig['mapProfileToUser']> = (
  profile,
) => ({ name: resolveProfileName(profile) });

type OIDCProviderInput = {
  clientId?: string;
  clientSecret?: string;
  issuer?: string;
  overrides?: Partial<GenericOAuthConfig>;
  pkce?: boolean;
  providerId: string;
  scopes?: string[];
};

export const buildOidcConfig = ({
  providerId,
  clientId,
  clientSecret,
  issuer,
  scopes = DEFAULT_OIDC_SCOPES,
  pkce = true,
  overrides,
}: OIDCProviderInput): GenericOAuthConfig => {
  const sanitizedIssuer = issuer?.trim();

  if (!clientId || !clientSecret || !sanitizedIssuer) {
    throw new Error(`[Better-Auth] ${providerId} OAuth enabled but missing credentials`);
  }

  const normalizedIssuer = sanitizedIssuer.replace(/\/$/, '');
  const discoveryUrl = createDiscoveryUrl(normalizedIssuer);

  return {
    clientId,
    clientSecret,
    discoveryUrl,
    mapProfileToUser: mapProfileNameToUser,
    pkce,
    providerId,
    scopes,
    ...overrides,
  } satisfies GenericOAuthConfig;
};
