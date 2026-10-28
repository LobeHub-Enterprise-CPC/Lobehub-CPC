import type { LobeChatDatabase } from '@lobechat/database';
import { ssoProviders } from '@lobechat/database/tenant/schemas';
import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { isPlainRecord } from '@lobechat/utils/object';
import { createAuthorizationCodeRequest, getOAuth2Tokens } from 'better-auth/oauth2';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import debug from 'debug';
import { and, eq, isNull } from 'drizzle-orm';
import { decodeJwt } from 'jose';

import { mapProfileNameToUser } from '@/libs/better-auth/sso/helpers';
import { openTenantData } from '@/server/crypto/tenantKeys';

const log = debug('lobe-server:tenant-sso');

/**
 * Reader of the tenant's `sso_providers` (spec A8, FR-ID-09). Admin writes the
 * rows; LobeHub only reads them and turns the enabled ones into the tenant's
 * better-auth providers. Secrets are a `v1.<iv>.<ciphertext>.<tag>` envelope
 * sealed with the tenant data key (spec A18) under AAD
 * `tenantId|providerId|revision` (Admin `src/server/sso/sharedSecrets.ts`).
 * A provider whose secrets do not open, or whose configuration is not one
 * this build can run, is left out: SSO fails closed per provider.
 */

export interface TenantSsoSecrets {
  clientSecret?: string;
  privateKey?: string;
  privateKeyPass?: string;
}

export const ssoSecretAad = (tenantId: string, providerId: string, revision: number) =>
  `${tenantId}|${providerId}|${revision}`;

export const openTenantSsoSecrets = (
  tenantId: string,
  row: { providerId: string; revision: number; secretConfigEncrypted: string },
): TenantSsoSecrets => {
  const parsed: unknown = JSON.parse(
    openTenantData(
      tenantId,
      row.secretConfigEncrypted,
      ssoSecretAad(tenantId, row.providerId, row.revision),
    ),
  );
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('SSO_SECRET_PAYLOAD_INVALID');
  const value = parsed as Record<string, unknown>;
  const pick = (key: keyof TenantSsoSecrets) =>
    typeof value[key] === 'string' && value[key] ? (value[key] as string) : undefined;
  return {
    clientSecret: pick('clientSecret'),
    privateKey: pick('privateKey'),
    privateKeyPass: pick('privateKeyPass'),
  };
};

export type TenantSsoProtocol = 'oauth2' | 'oidc';

/** The endpoints of an OIDC discovery document that sign-in uses. */
export interface OidcDiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
}

export interface TenantSsoProvider {
  admissionPolicy: string;
  /** Parsed protocol configuration (`oidc_config` / `oauth2_config`). */
  config: Record<string, unknown>;
  /**
   * Discovery documents fetched through the SSRF-safe transport, keyed by
   * discovery URL. better-auth never fetches discovery itself (see
   * `secureGenericOAuthConfig`).
   */
  discovery?: Record<string, OidcDiscoveryDocument>;
  displayName: string;
  issuer: string;
  logoUrl: string | null;
  protocol: TenantSsoProtocol;
  providerId: string;
  revision: number;
  secrets: TenantSsoSecrets;
}

type Row = typeof ssoProviders.$inferSelect;

/**
 * Only OIDC and generic OAuth 2.0 (`preset: 'custom'`) run here. Rows an older
 * build stored for SAML or a named OAuth2 vendor are skipped, not guessed at.
 */
export const toTenantSsoProvider = (tenantId: string, row: Row): TenantSsoProvider | null => {
  if (!row.enabled || row.deletedAt) return null;
  const protocol = row.protocol;
  if (protocol !== 'oidc' && protocol !== 'oauth2') return null;
  try {
    const config = protocol === 'oidc' ? row.oidcConfig : row.oauth2Config;
    if (!isPlainRecord(config)) return null;
    if (protocol === 'oauth2' && config.preset !== 'custom') return null;
    const secrets = row.secretConfigEncrypted
      ? openTenantSsoSecrets(tenantId, {
          providerId: row.providerId,
          revision: row.revision,
          secretConfigEncrypted: row.secretConfigEncrypted,
        })
      : {};
    return {
      admissionPolicy: row.admissionPolicy,
      config,
      displayName: row.displayName,
      issuer: row.issuer,
      logoUrl: row.logoUrl,
      protocol,
      providerId: row.providerId,
      revision: row.revision,
      secrets,
    };
  } catch {
    // Never log the row: it carries ciphertext and configuration.
    log('sso provider %s of tenant %s is unusable', row.providerId, tenantId);
    return null;
  }
};

/**
 * A provider as the sign-in page and the account settings may see it. The id,
 * the name an administrator gave it and its logo are all that leaves the
 * server: no client id, secret, issuer or endpoint (spec A8).
 */
export interface PublicSsoProvider {
  displayName: string;
  id: string;
  logoUrl: string | null;
  protocol: 'oauth2' | 'oidc';
}

const MAX_LOGO_URL_LENGTH = 2048;

/**
 * The logo of a frontend provider is a public HTTPS image URL: Admin accepts
 * nothing else for them (`FrontendSsoLogoSchema`; uploads exist only for
 * Admin's own sign-in, where the bytes live in Admin). Anything else cannot be
 * loaded from a tenant page, so it is left out and the page keeps its built-in
 * icon instead of requesting a broken or foreign path.
 */
export const publicSsoLogoUrl = (value: string | null | undefined): string | null => {
  const candidate = value?.trim();
  if (!candidate || candidate.length > MAX_LOGO_URL_LENGTH) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password ? candidate : null;
  } catch {
    return null;
  }
};

export const toPublicSsoProvider = (
  provider: Pick<TenantSsoProvider, 'displayName' | 'logoUrl' | 'protocol' | 'providerId'>,
): PublicSsoProvider => ({
  displayName: provider.displayName,
  id: provider.providerId,
  logoUrl: publicSsoLogoUrl(provider.logoUrl),
  protocol: provider.protocol === 'oauth2' ? 'oauth2' : 'oidc',
});

/** Enabled, usable providers of the tenant, in a stable order. */
export const loadTenantSsoProviders = async (
  db: LobeChatDatabase,
  tenantId: string,
): Promise<TenantSsoProvider[]> => {
  const rows = await db
    .select()
    .from(ssoProviders)
    .where(and(eq(ssoProviders.enabled, true), isNull(ssoProviders.deletedAt)))
    .orderBy(ssoProviders.providerId);
  const providers = rows
    .map((row) => toTenantSsoProvider(tenantId, row))
    .filter((provider): provider is TenantSsoProvider => provider !== null);

  return Promise.all(providers.map(withDiscovery));
};

const SSO_REQUEST_TIMEOUT_MS = 10_000;
const SSO_MAX_RESPONSE_BYTES = 1024 * 1024;
const DISCOVERY_TTL_MS = 5 * 60_000;
const DISCOVERY_FAILURE_TTL_MS = 60_000;
const MAX_DISCOVERY_ENTRIES = 256;
const discoveryCache = new Map<
  string,
  { document: OidcDiscoveryDocument | undefined; expiresAt: number }
>();
const discoveryRequests = new Map<string, Promise<OidcDiscoveryDocument | undefined>>();

const optionalString = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * Fetch an OIDC discovery document. The issuer / discovery URL is chosen by the
 * tenant admin, so the request goes through the SSRF-safe transport (connect-time
 * IP check, also on redirects). `undefined` when it cannot be fetched.
 */
export const fetchOidcDiscovery = async (
  url: string,
): Promise<OidcDiscoveryDocument | undefined> => {
  const cached = discoveryCache.get(url);
  if (cached && Date.now() < cached.expiresAt) return cached.document;
  const pending = discoveryRequests.get(url);
  if (pending) return pending;

  const request = (async () => {
    let document: OidcDiscoveryDocument | undefined;
    try {
      const response = await ssrfSafeFetch(
        url,
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(SSO_REQUEST_TIMEOUT_MS),
        },
        { maxContentLength: SSO_MAX_RESPONSE_BYTES },
      );
      if (!response.ok) throw new Error(`SSO discovery responded with HTTP ${response.status}`);
      const json: unknown = await response.json();
      if (!isPlainRecord(json)) throw new Error('SSO discovery is not an object');
      const authorizationEndpoint = optionalString(json.authorization_endpoint);
      const tokenEndpoint = optionalString(json.token_endpoint);
      if (!authorizationEndpoint || !tokenEndpoint)
        throw new Error('SSO discovery is missing required endpoints');
      document = {
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: tokenEndpoint,
        userinfo_endpoint: optionalString(json.userinfo_endpoint),
      };
    } catch {
      // Never log the response or tenant-selected URL; either can carry secrets.
      log('sso discovery is unavailable');
    }
    // Cache failures as well, starting the cooldown after the request finishes.
    discoveryCache.delete(url);
    discoveryCache.set(url, {
      document,
      expiresAt: Date.now() + (document ? DISCOVERY_TTL_MS : DISCOVERY_FAILURE_TTL_MS),
    });
    while (discoveryCache.size > MAX_DISCOVERY_ENTRIES)
      discoveryCache.delete(discoveryCache.keys().next().value!);
    return document;
  })();
  discoveryRequests.set(url, request);
  try {
    return await request;
  } finally {
    discoveryRequests.delete(url);
  }
};

/** The well-known discovery URL of an OIDC issuer. */
const issuerDiscoveryUrl = (issuer: string) => {
  const normalized = issuer.replace(/\/+$/, '');
  return normalized.includes('/.well-known/')
    ? normalized
    : `${normalized}/.well-known/openid-configuration`;
};

const discoveryUrlsOf = (provider: TenantSsoProvider) => {
  if (
    optionalString(provider.config.authorizationEndpoint) &&
    optionalString(provider.config.tokenEndpoint) &&
    optionalString(provider.config.userInfoEndpoint)
  )
    return [];

  if (provider.protocol !== 'oidc') return [];
  const explicit = optionalString(provider.config.discoveryEndpoint);
  const issuer = provider.issuer.trim();
  return explicit ? [explicit] : issuer ? [issuerDiscoveryUrl(issuer)] : [];
};

const withDiscovery = async (provider: TenantSsoProvider): Promise<TenantSsoProvider> => {
  const urls = discoveryUrlsOf(provider);
  if (urls.length === 0) return provider;

  const discovery: Record<string, OidcDiscoveryDocument> = {};
  await Promise.all(
    urls.map(async (url) => {
      const document = await fetchOidcDiscovery(url);
      if (document) discovery[url] = document;
    }),
  );

  return { ...provider, discovery };
};

const exchangeAuthorizationCode =
  (
    config: GenericOAuthConfig,
    tokenUrl: string | undefined,
  ): NonNullable<GenericOAuthConfig['getToken']> =>
  async ({ code, codeVerifier, redirectURI }) => {
    if (!tokenUrl) throw new Error('SSO token endpoint is not available');
    const { body, headers } = createAuthorizationCodeRequest({
      authentication: config.authentication,
      code,
      codeVerifier,
      headers: config.authorizationHeaders,
      options: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectURI: config.redirectURI,
      },
      redirectURI,
    });
    const response = await ssrfSafeFetch(
      tokenUrl,
      {
        body: body.toString(),
        headers,
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(SSO_REQUEST_TIMEOUT_MS),
      },
      { maxContentLength: SSO_MAX_RESPONSE_BYTES },
    );
    // Never surface the response body: with a tenant-chosen endpoint it is a read channel.
    if (!response.ok) throw new Error(`SSO token endpoint responded with HTTP ${response.status}`);
    return getOAuth2Tokens(await response.json());
  };

const isNonEmptyId = (id: unknown): id is string | number =>
  (typeof id === 'string' && id.length > 0) || typeof id === 'number';

/** better-auth's default generic-OAuth user info lookup, over the SSRF-safe transport. */
const fetchUserInfo =
  (userInfoUrl: string | undefined): NonNullable<GenericOAuthConfig['getUserInfo']> =>
  async (tokens) => {
    if (tokens.idToken) {
      const decoded = decodeJwt(tokens.idToken);
      if (decoded.sub && decoded.email) {
        return {
          emailVerified: decoded.email_verified,
          id: decoded.sub,
          image: decoded.picture,
          ...decoded,
        } as any;
      }
    }
    if (!userInfoUrl) return null;

    const response = await ssrfSafeFetch(
      userInfoUrl,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        method: 'GET',
        signal: AbortSignal.timeout(SSO_REQUEST_TIMEOUT_MS),
      },
      { maxContentLength: SSO_MAX_RESPONSE_BYTES },
    );
    if (!response.ok)
      throw new Error(`SSO userinfo endpoint responded with HTTP ${response.status}`);

    const profile = (await response.json()) as Record<string, any> | null;
    if (!profile) return null;
    const { id: profileId, ...profileFields } = profile;
    const subjectId = isNonEmptyId(profileId)
      ? profileId
      : isNonEmptyId(profile.sub)
        ? profile.sub
        : undefined;

    return {
      ...profileFields,
      ...(subjectId !== undefined && { id: subjectId }),
      email: profile.email,
      emailVerified: profile.email_verified ?? false,
      image: profile.picture,
      name: profile.name,
    } as any;
  };

/**
 * better-auth's generic OAuth calls discovery, the token endpoint and the user
 * info endpoint with its own `fetch`, which cannot be replaced. The endpoints
 * are chosen by the tenant admin, so none of them may be left to it: discovery
 * is taken from the SSRF-safe prefetch (`provider.discovery`), `discoveryUrl` is
 * dropped, and token / user info requests use `getToken` / `getUserInfo` over
 * the SSRF-safe transport.
 */
export const secureGenericOAuthConfig = (
  config: GenericOAuthConfig,
  discovery?: Record<string, OidcDiscoveryDocument>,
  providerConfig: Record<string, unknown> = {},
): GenericOAuthConfig => {
  const { discoveryUrl, ...rest } = config;
  const url = optionalString(providerConfig.discoveryEndpoint) ?? discoveryUrl;
  const document = url ? discovery?.[url] : undefined;

  const secured: GenericOAuthConfig = {
    ...rest,
    authentication: providerConfig.tokenEndpointAuthentication
      ? providerConfig.tokenEndpointAuthentication === 'client_secret_basic'
        ? 'basic'
        : 'post'
      : rest.authentication,
    authorizationUrl:
      optionalString(providerConfig.authorizationEndpoint) ??
      rest.authorizationUrl ??
      document?.authorization_endpoint,
    tokenUrl:
      optionalString(providerConfig.tokenEndpoint) ?? rest.tokenUrl ?? document?.token_endpoint,
    userInfoUrl:
      optionalString(providerConfig.userInfoEndpoint) ??
      rest.userInfoUrl ??
      document?.userinfo_endpoint,
  };
  secured.getToken ??= exchangeAuthorizationCode(secured, secured.tokenUrl);
  secured.getUserInfo ??= fetchUserInfo(secured.userInfoUrl);

  return secured;
};

/** Saved revisions and resolved discovery endpoints both determine instance validity. */
export const ssoRevisionKey = (providers: TenantSsoProvider[]) =>
  JSON.stringify(
    providers.map((provider) => [
      provider.providerId,
      provider.revision,
      Object.entries(provider.discovery ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([url, document]) => [
          url,
          document.authorization_endpoint,
          document.token_endpoint,
          document.userinfo_endpoint,
        ]),
    ]),
  );

/**
 * App path of the callback a tenant's identity provider redirects to (FR-ID-09,
 * A15); mount it on the tenant's active entry with `buildTenantPublicUrl`.
 */
export const tenantSsoCallbackPath = (providerId: string) =>
  `/api/auth/callback/${encodeURIComponent(providerId)}`;

const stringList = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
const string = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * better-auth `genericOAuth` configuration for an OIDC or custom OAuth2
 * provider. `null` for a provider missing its client secret or endpoints.
 */
export const toGenericOAuthConfig = (
  provider: TenantSsoProvider,
  redirectURI: string,
): GenericOAuthConfig | null => {
  const clientId = string(provider.config.clientId);
  const clientSecret = provider.secrets.clientSecret;
  if (!clientId || !clientSecret) return null;

  if (provider.protocol === 'oidc') {
    return secureGenericOAuthConfig(
      {
        authentication:
          provider.config.tokenEndpointAuthentication === 'client_secret_basic' ? 'basic' : 'post',
        authorizationUrl: string(provider.config.authorizationEndpoint),
        clientId,
        clientSecret,
        discoveryUrl:
          string(provider.config.discoveryEndpoint) ?? issuerDiscoveryUrl(provider.issuer.trim()),
        mapProfileToUser: mapProfileNameToUser,
        pkce: provider.config.pkce !== false,
        providerId: provider.providerId,
        redirectURI,
        scopes: stringList(provider.config.scopes) ?? ['openid', 'email', 'profile'],
        tokenUrl: string(provider.config.tokenEndpoint),
        userInfoUrl: string(provider.config.userInfoEndpoint),
      },
      provider.discovery,
    );
  }

  if (provider.protocol === 'oauth2' && provider.config.preset === 'custom') {
    const authorizationUrl = string(provider.config.authorizationEndpoint);
    const tokenUrl = string(provider.config.tokenEndpoint);
    const userInfoUrl = string(provider.config.userInfoEndpoint);
    if (!authorizationUrl || !tokenUrl || !userInfoUrl) return null;
    return secureGenericOAuthConfig({
      authentication:
        provider.config.tokenEndpointAuthentication === 'client_secret_basic' ? 'basic' : 'post',
      authorizationUrl,
      clientId,
      clientSecret,
      mapProfileToUser: mapProfileNameToUser,
      pkce: provider.config.pkce !== false,
      providerId: provider.providerId,
      redirectURI,
      scopes: stringList(provider.config.scopes) ?? ['profile', 'email'],
      tokenUrl,
      userInfoUrl,
    });
  }

  return null;
};
