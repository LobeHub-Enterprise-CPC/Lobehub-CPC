import { type GenericOAuthConfig } from 'better-auth/plugins';
import { type SocialProviders } from 'better-auth/social-providers';

import { type TenantSsoProvider, toGenericOAuthConfig } from '@/server/services/tenantSso';

import Apple from './sso/providers/apple';
import Auth0 from './sso/providers/auth0';
import Authelia from './sso/providers/authelia';
import Authentik from './sso/providers/authentik';
import Casdoor from './sso/providers/casdoor';
import CloudflareZeroTrust from './sso/providers/cloudflare-zero-trust';
import Cognito from './sso/providers/cognito';
import Feishu from './sso/providers/feishu';
import GenericOIDC from './sso/providers/generic-oidc';
import Github from './sso/providers/github';
import Google from './sso/providers/google';
import Keycloak from './sso/providers/keycloak';
import Logto from './sso/providers/logto';
import Microsoft from './sso/providers/microsoft';
import Okta from './sso/providers/okta';
import Wechat from './sso/providers/wechat';
import Zitadel from './sso/providers/zitadel';

/**
 * Tenant SSO through the built-in presets (`./sso`, kept as upstream ships
 * them). A preset normally reads its credentials from `AUTH_<PROVIDER>_*` in
 * `checkEnvs`; here it never does: the tenant's `sso_providers` row (written by
 * Admin, secrets already opened) is turned into the same shape and handed to
 * the preset's `build`.
 *
 * Which preset a row selects:
 * - `oauth2` rows: `oauth2_config.preset` (Admin's preset id, e.g. `github`,
 *   `feishu`); `custom` keeps the generic OAuth2 configuration.
 * - `oidc` rows: the `provider_id`, when it names a preset (e.g. `okta`,
 *   `google`, `microsoft-entra-id`); any other id is plain OIDC discovery.
 * A built-in preset (better-auth social provider) is keyed by its own id, so
 * it runs only for the row whose `provider_id` is exactly that id (`google`,
 * not `microsoft-entra-id` for `microsoft`). A row whose preset
 * cannot be built from its fields is left out: SSO fails closed per provider.
 */

interface Credentials {
  clientId: string;
  clientSecret: string;
  issuer?: string;
}

type PresetEnv = Record<string, string | undefined>;

const oidcEnv =
  (prefix: string) =>
  ({ clientId, clientSecret, issuer }: Credentials): PresetEnv | null =>
    issuer
      ? {
          [`${prefix}_ID`]: clientId,
          [`${prefix}_ISSUER`]: issuer,
          [`${prefix}_SECRET`]: clientSecret,
        }
      : null;

/** `https://login.microsoftonline.com/{tenant}/v2.0` → authority and tenant. */
const microsoftEnv = ({ clientId, clientSecret, issuer }: Credentials): PresetEnv => {
  let authority: string | undefined;
  let tenantId: string | undefined;
  try {
    if (issuer) {
      const url = new URL(issuer);
      authority = url.origin;
      tenantId = url.pathname.split('/').find(Boolean);
    }
  } catch {
    // Not a URL: the preset falls back to its defaults (`common`).
  }
  return {
    AUTH_MICROSOFT_AUTHORITY_URL: authority,
    AUTH_MICROSOFT_ID: clientId,
    AUTH_MICROSOFT_SECRET: clientSecret,
    AUTH_MICROSOFT_TENANT_ID: tenantId,
  };
};

/**
 * Each preset with the `checkEnvs` shape its `build` expects, filled from the
 * row. `null` when the row lacks a field the preset requires.
 */
const presets = [
  {
    definition: Apple,
    env: ({ clientId, clientSecret }: Credentials): PresetEnv => ({
      AUTH_APPLE_CLIENT_ID: clientId,
      AUTH_APPLE_CLIENT_SECRET: clientSecret,
    }),
  },
  { definition: Auth0, env: oidcEnv('AUTH_AUTH0') },
  { definition: Authelia, env: oidcEnv('AUTH_AUTHELIA') },
  { definition: Authentik, env: oidcEnv('AUTH_AUTHENTIK') },
  { definition: Casdoor, env: oidcEnv('AUTH_CASDOOR') },
  { definition: CloudflareZeroTrust, env: oidcEnv('AUTH_CLOUDFLARE_ZERO_TRUST') },
  // Needs the hosted UI domain, which no `sso_providers` field carries.
  { definition: Cognito, env: (): PresetEnv | null => null },
  {
    definition: Feishu,
    env: ({ clientId, clientSecret }: Credentials): PresetEnv => ({
      AUTH_FEISHU_APP_ID: clientId,
      AUTH_FEISHU_APP_SECRET: clientSecret,
    }),
  },
  { definition: GenericOIDC, env: oidcEnv('AUTH_GENERIC_OIDC') },
  {
    definition: Github,
    env: ({ clientId, clientSecret }: Credentials): PresetEnv => ({
      AUTH_GITHUB_ID: clientId,
      AUTH_GITHUB_SECRET: clientSecret,
    }),
  },
  {
    definition: Google,
    env: ({ clientId, clientSecret }: Credentials): PresetEnv => ({
      AUTH_GOOGLE_ID: clientId,
      AUTH_GOOGLE_SECRET: clientSecret,
    }),
  },
  { definition: Keycloak, env: oidcEnv('AUTH_KEYCLOAK') },
  { definition: Logto, env: oidcEnv('AUTH_LOGTO') },
  { definition: Microsoft, env: microsoftEnv },
  { definition: Okta, env: oidcEnv('AUTH_OKTA') },
  {
    definition: Wechat,
    env: ({ clientId, clientSecret }: Credentials): PresetEnv => ({
      AUTH_WECHAT_ID: clientId,
      AUTH_WECHAT_SECRET: clientSecret,
    }),
  },
  { definition: Zitadel, env: oidcEnv('AUTH_ZITADEL') },
] as const;

type Preset = (typeof presets)[number];

const presetRegistry = new Map<string, Preset>();
for (const preset of presets) {
  presetRegistry.set(preset.definition.id, preset);
  for (const alias of preset.definition.aliases ?? []) presetRegistry.set(alias, preset);
}

/** The preset id a row selects, if any (see the module comment). */
export const tenantSsoPresetId = (provider: TenantSsoProvider): string | undefined => {
  const selector =
    provider.protocol === 'oauth2'
      ? provider.config.preset
      : provider.protocol === 'oidc'
        ? provider.providerId
        : undefined;
  if (typeof selector !== 'string') return undefined;
  return presetRegistry.get(selector)?.definition.id;
};

export interface TenantSsoProviderSet {
  /** Generic OAuth configurations (presets and plain OIDC / custom OAuth2). */
  genericOAuthProviders: GenericOAuthConfig[];
  /** Provider ids better-auth serves through generic OAuth (`/oauth2/callback/{id}`). */
  genericProviderIds: string[];
  /** The tenant's providers this build can run, in their stable order. */
  providers: TenantSsoProvider[];
  /** Built-in presets (better-auth social providers), keyed by their own id. */
  socialProviders: SocialProviders;
}

/**
 * better-auth providers for the tenant's enabled `sso_providers`.
 * `redirectURI(providerId)` is the tenant callback registered with the
 * identity provider (`/t/{slug}/api/auth/callback/{providerId}`).
 */
export const buildTenantSsoProviders = (
  providers: TenantSsoProvider[],
  redirectURI: (providerId: string) => string,
): TenantSsoProviderSet => {
  const result: TenantSsoProviderSet = {
    genericOAuthProviders: [],
    genericProviderIds: [],
    providers: [],
    socialProviders: {},
  };

  for (const provider of providers) {
    const presetId = tenantSsoPresetId(provider);

    if (!presetId) {
      const config = toGenericOAuthConfig(provider, redirectURI(provider.providerId));
      if (!config) continue;
      result.genericOAuthProviders.push(config);
      result.genericProviderIds.push(provider.providerId);
      result.providers.push(provider);
      continue;
    }

    const { definition, env } = presetRegistry.get(presetId)!;
    const clientId = provider.config.clientId;
    const clientSecret = provider.secrets.clientSecret;
    if (typeof clientId !== 'string' || !clientId || !clientSecret) continue;
    const presetEnv = env({ clientId, clientSecret, issuer: provider.issuer || undefined });
    if (!presetEnv) continue;

    try {
      if (definition.type === 'builtin') {
        // Social providers are keyed and called back by their own id
        // (`/callback/{id}`), and the client signs in with `signIn.social` for
        // exactly these ids, so the row must be named after the preset.
        if (provider.providerId !== definition.id || result.socialProviders[definition.id])
          continue;
        // @ts-expect-error - build expects its preset's env type; presetEnv is the matching shape
        result.socialProviders[definition.id] = definition.build(presetEnv);
      } else {
        // @ts-expect-error - build expects its preset's env type; presetEnv is the matching shape
        const config: GenericOAuthConfig = definition.build(presetEnv);
        config.providerId = provider.providerId;
        config.redirectURI = redirectURI(provider.providerId);
        result.genericOAuthProviders.push(config);
        result.genericProviderIds.push(provider.providerId);
      }
      result.providers.push(provider);
    } catch {
      // A preset that rejects the row (e.g. a malformed issuer) is left out.
    }
  }

  return result;
};
