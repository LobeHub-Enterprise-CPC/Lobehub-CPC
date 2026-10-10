import type { LobeChatDatabase } from '@lobechat/database';
import { ssoProviders } from '@lobechat/database/tenant/schemas';
import { isPlainRecord } from '@lobechat/utils/object';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import debug from 'debug';
import { and, eq, isNull } from 'drizzle-orm';

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

export type TenantSsoProtocol = 'oauth2' | 'oidc' | 'saml';

export interface TenantSsoProvider {
  admissionPolicy: string;
  /** Parsed protocol configuration (`oidc_config` / `oauth2_config` / `saml_config`). */
  config: Record<string, unknown>;
  displayName: string;
  issuer: string;
  logoUrl: string | null;
  protocol: TenantSsoProtocol;
  providerId: string;
  revision: number;
  secrets: TenantSsoSecrets;
}

type Row = typeof ssoProviders.$inferSelect;

export const toTenantSsoProvider = (tenantId: string, row: Row): TenantSsoProvider | null => {
  if (!row.enabled || row.deletedAt) return null;
  const protocol = row.protocol as TenantSsoProtocol;
  if (protocol !== 'oidc' && protocol !== 'oauth2' && protocol !== 'saml') return null;
  try {
    const config =
      protocol === 'oidc'
        ? row.oidcConfig
        : protocol === 'oauth2'
          ? row.oauth2Config
          : row.samlConfig;
    if (!isPlainRecord(config)) return null;
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
  return rows
    .map((row) => toTenantSsoProvider(tenantId, row))
    .filter((provider): provider is TenantSsoProvider => provider !== null);
};

/** Changes whenever a provider is added, removed or saved (Admin bumps `revision`). */
export const ssoRevisionKey = (providers: TenantSsoProvider[]) =>
  providers.map((p) => `${p.providerId}:${p.revision}`).join(',');

/** The callback a tenant's identity provider redirects to (FR-ID-09, A15). */
export const tenantSsoCallbackPath = (tenantSlug: string, providerId: string) =>
  `/t/${tenantSlug}/api/auth/callback/${encodeURIComponent(providerId)}`;

const stringList = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
const string = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * better-auth `genericOAuth` configuration for an OIDC or custom OAuth2
 * provider. `null` for a provider this build cannot run yet (named OAuth2
 * presets, SAML) or one missing its client secret.
 */
export const toGenericOAuthConfig = (
  provider: TenantSsoProvider,
  redirectURI: string,
): GenericOAuthConfig | null => {
  const clientId = string(provider.config.clientId);
  const clientSecret = provider.secrets.clientSecret;
  if (!clientId || !clientSecret) return null;

  if (provider.protocol === 'oidc') {
    const issuer = provider.issuer.replace(/\/+$/, '');
    return {
      authorizationUrl: string(provider.config.authorizationEndpoint),
      clientId,
      clientSecret,
      discoveryUrl:
        string(provider.config.discoveryEndpoint) ?? `${issuer}/.well-known/openid-configuration`,
      pkce: provider.config.pkce !== false,
      providerId: provider.providerId,
      redirectURI,
      scopes: stringList(provider.config.scopes) ?? ['openid', 'email', 'profile'],
      tokenUrl: string(provider.config.tokenEndpoint),
      userInfoUrl: string(provider.config.userInfoEndpoint),
    };
  }

  if (provider.protocol === 'oauth2' && provider.config.preset === 'custom') {
    const authorizationUrl = string(provider.config.authorizationEndpoint);
    const tokenUrl = string(provider.config.tokenEndpoint);
    const userInfoUrl = string(provider.config.userInfoEndpoint);
    if (!authorizationUrl || !tokenUrl || !userInfoUrl) return null;
    return {
      authentication:
        provider.config.tokenEndpointAuthentication === 'client_secret_basic' ? 'basic' : 'post',
      authorizationUrl,
      clientId,
      clientSecret,
      pkce: provider.config.pkce !== false,
      providerId: provider.providerId,
      redirectURI,
      scopes: stringList(provider.config.scopes) ?? ['profile', 'email'],
      tokenUrl,
      userInfoUrl,
    };
  }

  return null;
};
