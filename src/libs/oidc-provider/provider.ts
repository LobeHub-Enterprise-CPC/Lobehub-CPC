import { assertBusinessUserAccess, isBusinessAuthorizationError } from '@lobechat/business-auth';
import type { LobeChatDatabase } from '@lobechat/database';
import type { TenantScope } from '@lobechat/database/tenant';
import debug from 'debug';
import type { Configuration, KoaContextWithOIDC } from 'oidc-provider';
import Provider, { errors } from 'oidc-provider';

import { UserModel } from '@/database/models/user';
import { getJWKS } from '@/libs/oidc-provider/jwt';
import { OIDC_ISSUER_PATH, OIDC_ROUTES } from '@/libs/oidc-provider/routes';
import { TENANT_ID_CLAIM } from '@/libs/trpc/utils/tenantBinding';
import { normalizeLocale } from '@/locales/resources';
import { findSlugEndpoint } from '@/server/modules/Tenant/endpoints';
import { projectGatewayOIDCAccess } from '@/server/services/gatewayAuthorization/oidcProjection';
import { hasOtherOrganizations } from '@/server/services/tenantDiscovery/otherOrganizations';

import { accessTokenTTL, isAcceptanceReviewClient, reviewResourceServer } from './acceptanceReview';
import { isOIDCUserBanned } from './access-control';
import { DrizzleAdapter } from './adapter';
import { defaultClaims, defaultClients, defaultScopes } from './config';
import { getOIDCCookieKeys } from './cookies';
import { DESKTOP_CLIENT_ID } from './desktopClient';
import { createInteractionPolicy } from './interaction-policy';
import { describeError } from './safe-log';

const logProvider = debug('lobe-oidc:provider');

export const API_AUDIENCE = 'urn:lobehub:chat';

// First-party native client added upstream (#21429). Like the desktop client, its
// callback is registered per tenant below, not at the deployment root (`config.ts`).
const TOBY_CLIENT_ID = 'toby';

// One deadline for every optional display claim of an id_token.
const DISPLAY_CLAIMS_BUDGET_MS = 1000;

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

// Keep all artifact TTLs explicit; oidc-provider validates its default TTL functions at runtime.
export const oidcArtifactTTL = {
  AccessToken: 7 * DAY_SECONDS,
  AuthorizationCode: 10 * MINUTE_SECONDS,
  BackchannelAuthenticationRequest: 10 * MINUTE_SECONDS,
  ClientCredentials: 10 * MINUTE_SECONDS,
  DeviceCode: 10 * MINUTE_SECONDS,
  /**
   * A grant is the standing record of "this account authorised this client". oidc-provider
   * checks `grant.isExpired` on every refresh but never extends `Grant.exp`, so any finite
   * value here caps a signed-in session however active it is: the library's 14-day default
   * logged every client out a fortnight after login while its refresh token still sat unused
   * and unexpired. Inactivity is already expressed by `RefreshToken`, whose TTL restarts on
   * each rotation, so a grant carries no deadline of its own. `ttl` entries do accept
   * `undefined`, but the configuration merge drops undefined values, so "never" has to be
   * spelled as a century.
   */
  Grant: 100 * 365 * DAY_SECONDS,
  IdToken: HOUR_SECONDS,
  Interaction: HOUR_SECONDS,
  RefreshToken: 30 * DAY_SECONDS,
  Session: 30 * DAY_SECONDS,
} satisfies NonNullable<Configuration['ttl']>;

/**
 * Display-only id_token claims, resolved under one shared deadline. Nothing here may delay or fail
 * a sign-in or refresh: whatever has not answered when the budget is spent is left out (the
 * desktop client reads a missing value as "unknown"), and the identity claims go out regardless.
 *
 * The organization name is read live rather than captured when the provider is created: providers
 * are cached per tenant, slug and endpoint version, none of which change on a rename.
 *
 * Work still running at the deadline: the cross-organization lookup is cancelled (its connections
 * are released and destroyed). The directory read is a shared, de-duplicated routing-cache fetch
 * that other requests may be waiting on, so it is abandoned rather than cancelled; it ends on its
 * own with the database statement timeout and returns its connection to the pool, and there is at
 * most one per key at a time.
 */
const resolveDisplayClaims = async (
  slug: string,
  tenantId: string,
  otherOrganizationsEmail: string | undefined,
): Promise<Record<string, string | boolean>> => {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), DISPLAY_CLAIMS_BUDGET_MS);
  const expired = new Promise<never>((_, reject) =>
    budget.signal.addEventListener('abort', () => reject(new Error('DISPLAY_CLAIMS_TIMEOUT')), {
      once: true,
    }),
  );
  expired.catch(() => {});
  const bounded = <T>(work: () => Promise<T>) =>
    Promise.race([work(), expired]).catch((error: unknown) => {
      logProvider('Optional id_token claim skipped: %s', describeError(error));
      return undefined;
    });

  try {
    const [organization, others] = await Promise.all([
      bounded(() => findSlugEndpoint(slug)),
      otherOrganizationsEmail
        ? bounded(() =>
            hasOtherOrganizations(otherOrganizationsEmail, tenantId, { signal: budget.signal }),
          )
        : undefined,
    ]);

    const claims: Record<string, string | boolean> = {};
    if (organization?.tenantId === tenantId) {
      if (organization.name) claims.tenant_name = organization.name;
      if (organization.slug) claims.tenant_slug = organization.slug;
    }
    // `undefined` is "unknown": the client must not read it as "no".
    if (others !== undefined) claims.has_other_organizations = others;
    return claims;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Create OIDC Provider instance
 * @param db - Database instance
 * @returns Configured OIDC Provider instance
 */
export const createOIDCProvider = async (
  db: LobeChatDatabase,
  { endpoint, slug, tenantId }: Pick<TenantScope, 'endpoint' | 'slug' | 'tenantId'>,
): Promise<Provider> => {
  // Routes, cookies and redirects live under the tenant's active entry.
  const tenantPath = (path: string) =>
    path === '/' ? endpoint.basePath || '/' : `${endpoint.basePath}${path}`;
  // Get JWKS
  const jwks = getJWKS();

  const cookieKeys = getOIDCCookieKeys();

  const configuration: Configuration = {
    // 11. Database adapter
    adapter: DrizzleAdapter.createAdapterFactory(db),

    // 4. Claims definition
    claims: defaultClaims,

    // Added: client-based CORS control logic
    clientBasedCORS(ctx, origin, client) {
      // The review toolbar runs on whatever origin the delivered product is
      // previewed on; its token is scoped to one acceptance by audience.
      if (isAcceptanceReviewClient(client?.clientId)) return true;

      // Check if the client allows this origin
      // A common strategy is to allow origins of all registered redirect_uris
      if (!client || !client.redirectUris) {
        logProvider('clientBasedCORS: No client or redirectUris found, denying origin: %s', origin);
        return false; // Deny if no client or redirect URIs
      }

      const allowed = client.redirectUris.some((uri) => {
        try {
          // Compare origins (scheme, hostname, port)
          return new URL(uri).origin === origin;
        } catch {
          // Skip if redirect_uri is not a valid URL (e.g. custom protocol)
          return false;
        }
      });

      logProvider(
        'clientBasedCORS check for origin [%s] and client [%s]: %s',
        origin,
        client.clientId,
        allowed ? 'Allowed' : 'Denied',
      );
      return allowed;
    },

    // 1. Client configuration
    clients: defaultClients.map((client) =>
      client.client_id === DESKTOP_CLIENT_ID
        ? {
            ...client,
            redirect_uris: [
              ...new Set([
                ...(client.redirect_uris ?? []),
                `${endpoint.publicUrl}/oidc/callback/desktop`,
              ]),
            ],
            post_logout_redirect_uris: [
              ...new Set([
                ...(client.post_logout_redirect_uris ?? []),
                `${endpoint.publicUrl}/oauth/logout`,
              ]),
            ],
          }
        : client.client_id === TOBY_CLIENT_ID
          ? {
              ...client,
              redirect_uris: [
                ...new Set([
                  ...(client.redirect_uris ?? []),
                  `${endpoint.publicUrl}/oidc/callback/toby`,
                ]),
              ],
            }
          : client,
    ),

    // Tenants share one signing key, so the JWT access token itself must say
    // which tenant issued it; `validateOIDCJWT` rejects any other tenant. The id
    // is fixed when this tenant's provider is created, not read per request.
    extraTokenClaims: async () => ({ [TENANT_ID_CLAIM]: tenantId }),
    formats: { customizers: { jwt: projectGatewayOIDCAccess } },

    // Added: ensure ID Token includes claims for all scopes, not just openid scope
    conformIdTokenClaims: false,

    // 7. Cookie configuration
    cookies: {
      keys: cookieKeys,
      long: { path: tenantPath('/'), signed: true },
      short: { path: tenantPath('/'), signed: true },
    },

    // 5. Features configuration
    features: {
      backchannelLogout: { enabled: true },
      clientCredentials: { enabled: false },
      devInteractions: { enabled: false },
      deviceFlow: {
        charset: 'base-20',
        enabled: true,
        mask: '****-****',
        successSource: async (ctx) => {
          ctx.redirect(tenantPath('/oauth/device/success'));
        },
        userCodeConfirmSource: async (ctx, form, client, deviceInfo, userCode) => {
          const xsrf = (ctx.oidc.session as any)?.state?.secret;
          const params = new URLSearchParams();
          if (xsrf) params.set('xsrf', xsrf);
          params.set('user_code', userCode);
          params.set('client_name', client.clientName || client.clientId);
          params.set('client_id', client.clientId);
          ctx.redirect(tenantPath(`/oauth/device/confirm?${params.toString()}`));
        },
        userCodeInputSource: async (ctx, form, out, err) => {
          const xsrf = (ctx.oidc.session as any)?.state?.secret;
          const params = new URLSearchParams();
          if (xsrf) params.set('xsrf', xsrf);
          if (err) {
            params.set('error', err.message || 'Unknown error');
            if ((err as any).userCode) params.set('user_code', (err as any).userCode);
          }
          ctx.redirect(tenantPath(`/oauth/device?${params.toString()}`));
        },
      },
      introspection: { enabled: true },
      resourceIndicators: {
        defaultResource: () => API_AUDIENCE,
        enabled: true,

        getResourceServerInfo: (ctx, resourceIndicator) => {
          logProvider('getResourceServerInfo called with indicator: %s', resourceIndicator); // <-- Add this log line
          const review = reviewResourceServer(
            ctx.oidc.client?.clientId,
            resourceIndicator,
            ctx.oidc.params?.resource,
          );
          if (review === 'reject') throw new errors.InvalidTarget();
          if (review) return review;

          if (resourceIndicator === API_AUDIENCE) {
            logProvider('Indicator matches API_AUDIENCE, returning JWT config.'); // <-- Add this log line
            return {
              accessTokenFormat: 'jwt',
              audience: API_AUDIENCE,
              scope: ctx.oidc.client?.scope || 'read',
            };
          }

          logProvider('Indicator does not match API_AUDIENCE, throwing InvalidTarget.'); // <-- Add this log line
          throw new errors.InvalidTarget();
        },
        // When a client uses a refresh token to request a new access token without specifying a resource, the authorization server checks all resources included in the original authorization and uses them for the new access token. This provides a convenient way to maintain authorization consistency without requiring the client to re-specify all resources on each refresh.
        useGrantedResource: () => true,
      },
      revocation: { enabled: true },
      rpInitiatedLogout: { enabled: true },
      userinfo: { enabled: true },
    },
    // 10. Account lookup
    async findAccount(ctx: KoaContextWithOIDC, id: string) {
      logProvider('findAccount called for id: %s', id);

      // Check if there is a pre-stored external account ID
      // @ts-ignore - Custom property
      const externalAccountId = ctx.externalAccountId;
      if (externalAccountId) {
        logProvider('Found externalAccountId in context: %s', externalAccountId);
      }

      // Determine the account ID to look up
      // Priority: 1. externalAccountId 2. ctx.oidc.session?.accountId 3. passed-in id
      const accountIdToFind = externalAccountId || ctx.oidc?.session?.accountId || id;

      const clientId = ctx.oidc?.client?.clientId;

      logProvider('OIDC request client id: %s', clientId);

      logProvider(
        'Attempting to find account with ID: %s (source: %s)',
        accountIdToFind,
        externalAccountId
          ? 'externalAccountId'
          : ctx.oidc?.session?.accountId
            ? 'oidc_session'
            : 'parameter_id',
      );

      // Return undefined if no account ID is available
      if (!accountIdToFind) {
        logProvider('findAccount: No account ID available, returning undefined.');
        return undefined;
      }

      try {
        const user = await UserModel.findById(db, accountIdToFind);
        logProvider('UserModel.findById found a user for %s: %s', accountIdToFind, !!user);

        if (!user) {
          logProvider('No user found for accountId: %s', accountIdToFind);
          return undefined;
        }

        if (isOIDCUserBanned(user)) {
          logProvider('Account is banned for accountId: %s', accountIdToFind);
          return undefined;
        }

        await assertBusinessUserAccess(db, user.id);
        return {
          accountId: user.id,
          async claims(use, scope): Promise<{ [key: string]: any; sub: string }> {
            logProvider('claims function called for user %s with scope: %s', user.id, scope);
            const claims: { [key: string]: any; sub: string } = {
              sub: user.id,
            };

            if (scope.includes('profile')) {
              claims.name =
                user.fullName ||
                user.username ||
                `${user.firstName || ''} ${user.lastName || ''}`.trim();
              claims.picture = user.avatar;
            }

            if (scope.includes('email')) {
              claims.email = user.email;
              claims.email_verified = !!user.emailVerifiedAt;
            }

            // Display text for the desktop confirmation card; the id_token is the only carrier,
            // so neither userinfo nor access tokens expose the organization.
            if (use === 'id_token') {
              // Only the desktop client shows the organization-switch affordance this claim
              // drives. The client is read from the live request: claims() is not handed one.
              const desktop = ctx.oidc?.client?.clientId === DESKTOP_CLIENT_ID;
              Object.assign(
                claims,
                await resolveDisplayClaims(
                  slug,
                  tenantId,
                  desktop ? user.email || undefined : undefined,
                ),
              );
            }

            logProvider('Returning claims: %s', Object.keys(claims).join(','));
            return claims;
          },
        };
      } catch (error) {
        if (isBusinessAuthorizationError(error))
          throw Object.assign(error, { statusCode: error.status, expose: true });
        logProvider('Error finding account or generating claims: %s', describeError(error));
        console.error(`Error finding account: ${describeError(error)}`);
        throw Object.assign(new Error('AUTHORIZATION_UNAVAILABLE', { cause: error }), {
          code: 'AUTHORIZATION_UNAVAILABLE',
          status: 503,
          statusCode: 503,
          expose: true,
        });
      }
    },

    // 9. Interaction policy
    interactions: {
      policy: createInteractionPolicy(),
      url(ctx, interaction) {
        // ---> Add logs <---
        logProvider('interactions.url function called');

        // Read the ui_locales parameter from the OIDC request (space-separated language priorities)
        // https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
        const uiLocalesRaw = (interaction.params?.ui_locales || ctx.oidc?.params?.ui_locales) as
          string | undefined;

        let query = '';
        if (uiLocalesRaw) {
          // Take the first priority language and normalize it to a site-supported tag
          const first = uiLocalesRaw.split(/[\s,]+/).find(Boolean);
          const hl = normalizeLocale(first);
          query = `?hl=${encodeURIComponent(hl)}`;
          logProvider('Detected ui_locales=%s -> using hl=%s', uiLocalesRaw, hl);
        } else {
          logProvider('No ui_locales provided in authorization request');
        }

        // A login prompt is bridged on the server (sign-in redirect, or the existing tenant
        // session); every other prompt still opens the consent page.
        const interactionUrl = tenantPath(
          interaction.prompt.name === 'login'
            ? `/oidc/interaction/${interaction.uid}/login${query}`
            : `/oauth/consent/${interaction.uid}${query}`,
        );
        logProvider('Generated interaction URL');
        // ---> End of added logs <---
        return interactionUrl;
      },
    },

    // 6. Key configuration - using RS256 JWKS
    jwks: jwks as { keys: any[] },

    // 2. PKCE configuration
    pkce: {
      required: () => true,
    },

    // 12. Other configuration
    // Errors the provider will not redirect back to the client with (an
    // unregistered redirect_uri, an unknown client, malformed parameters) land
    // on a dedicated page instead of a raw JSON dump. Only the spec-defined
    // `error` and `error_description` travel along; `state` stays behind.
    renderError: async (ctx, out, error) => {
      logProvider('renderError: %s', describeError(error));

      const params = new URLSearchParams();
      if (out.error) params.set('error', String(out.error));
      if (out.error_description) params.set('error_description', String(out.error_description));

      ctx.redirect(tenantPath(`/oauth/error?${params.toString()}`));
    },

    // Added: enable refresh token rotation
    rotateRefreshToken: true,

    // Every route is written with the `/oidc` prefix because the provider is
    // mounted under it and the adapter hands it the untouched pathname. A route
    // left at its default (e.g. `/jwks`) is therefore unreachable: the request
    // arrives as `/oidc/jwks` and the provider answers 404.
    routes: Object.fromEntries(
      Object.entries(OIDC_ROUTES).map(([key, value]) => [key, tenantPath(value)]),
    ),
    // 3. Scopes definition
    scopes: defaultScopes,

    // 8. Token TTL
    ttl: {
      ...oidcArtifactTTL,
      AccessToken: (ctx, token) => accessTokenTTL(token, oidcArtifactTTL.AccessToken),
    },
  };

  // Create provider instance
  // Future activation UI must warn that changing the active entry changes issuer and migrates clients.
  const baseUrl = `${endpoint.publicUrl}${OIDC_ISSUER_PATH}`;

  const provider = new Provider(baseUrl, configuration);
  provider.proxy = true;

  provider.on('server_error', (ctx, err) => {
    logProvider('OIDC Provider Server Error: %s', describeError(err)); // Use logProvider
    console.error(`OIDC Provider Error: ${describeError(err)}`);
  });

  provider.on('authorization.success', (ctx) => {
    logProvider('Authorization successful for client: %s', ctx.oidc.client?.clientId); // Use logProvider
  });

  /**
   * A rejected token request is the moment a client loses its session, and until this listener
   * existed it left no trace on the server: oidc-provider answers the client and nothing else,
   * so the platform logs showed a bare `POST /oidc/token 400` with no client, no grant type and
   * no reason. `error_detail` is the field worth having — it separates "grant not found" from
   * "refresh token already used" from "client mismatch", and the spec keeps it out of the
   * response body, so the server is the only place it can be read.
   *
   * Logged at warn, not error: a client presenting a dead token is its own fault, not an
   * incident, and drowning the error feed in it would bury the failures that are ours.
   */
  provider.on('grant.error', (ctx, err) => {
    const error = err as { error?: string; error_description?: string; error_detail?: string };

    console.warn(
      '[OIDC] grant rejected',
      JSON.stringify({
        clientId: ctx.oidc?.client?.clientId,
        error: error.error,
        errorDescription: error.error_description,
        errorDetail: error.error_detail,
        grantType: ctx.oidc?.params?.grant_type,
        status: ctx.status,
      }),
    );
  });

  provider.on('grant.revoked', (ctx) => {
    console.warn(
      '[OIDC] grant revoked',
      JSON.stringify({
        clientId: ctx.oidc?.client?.clientId,
        grantType: ctx.oidc?.params?.grant_type,
      }),
    );
  });

  return provider;
};

export { type default as OIDCProvider } from 'oidc-provider';
