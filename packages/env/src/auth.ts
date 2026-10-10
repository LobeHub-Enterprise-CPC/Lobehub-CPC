import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      /** Comma-separated origins merged into Better Auth's resolved trusted origins. */
      AUTH_ADDITIONAL_TRUSTED_ORIGINS?: string;

      // ===== Better Auth ===== //
      AUTH_DISABLE_EMAIL_PASSWORD?: string;

      AUTH_EMAIL_VERIFICATION?: string;
      AUTH_ENABLE_MAGIC_LINK?: string;

      AUTH_SECRET?: string;
      AUTH_TRUSTED_ORIGINS?: string;

      /**
       * Internal JWT expiration time for lambda → async calls.
       * Format: number followed by unit (s=seconds, m=minutes, h=hours)
       * Examples: '10s', '1m', '1h'
       * Should be as short as possible for security, but long enough to account for network latency and server processing time.
       * @default '30s'
       */
      INTERNAL_JWT_EXPIRATION?: string;

      // ===== JWKS Key ===== //
      /**
       * Generic JWKS key for signing/verifying JWTs.
       * Used for internal service authentication and other cryptographic operations.
       * Must be a JWKS JSON string containing an RS256 RSA key pair.
       * Can be generated using `node scripts/generate-oidc-jwk.mjs`.
       */
      JWKS_KEY?: string;
    }
  }
}

export const getAuthConfig = () => {
  return createEnv({
    clientPrefix: 'NEXT_PUBLIC_',
    client: {},
    server: {
      AUTH_SECRET: z.string().optional(),
      AUTH_ADDITIONAL_TRUSTED_ORIGINS: z.string().optional(),
      AUTH_TRUSTED_ORIGINS: z.string().optional(),
      AUTH_EMAIL_VERIFICATION: z.boolean().optional().default(false),
      AUTH_ENABLE_MAGIC_LINK: z.boolean().optional().default(false),
      AUTH_DISABLE_EMAIL_PASSWORD: z.boolean().optional().default(false),

      LOGTO_WEBHOOK_SIGNING_KEY: z.string().optional(),

      // Casdoor
      CASDOOR_WEBHOOK_SECRET: z.string().optional(),

      // Generic JWKS key for signing/verifying JWTs
      JWKS_KEY: z.string().optional(),
      ENABLE_OIDC: z.boolean(),

      // Internal JWT expiration time (e.g., '10s', '1m', '1h')
      INTERNAL_JWT_EXPIRATION: z.string().default('30s'),
    },

    runtimeEnv: {
      AUTH_ADDITIONAL_TRUSTED_ORIGINS: process.env.AUTH_ADDITIONAL_TRUSTED_ORIGINS,
      AUTH_EMAIL_VERIFICATION: process.env.AUTH_EMAIL_VERIFICATION === '1',
      AUTH_ENABLE_MAGIC_LINK: process.env.AUTH_ENABLE_MAGIC_LINK === '1',
      AUTH_SECRET: process.env.AUTH_SECRET,
      AUTH_TRUSTED_ORIGINS: process.env.AUTH_TRUSTED_ORIGINS,
      AUTH_DISABLE_EMAIL_PASSWORD: process.env.AUTH_DISABLE_EMAIL_PASSWORD === '1',

      // LOGTO
      LOGTO_WEBHOOK_SIGNING_KEY: process.env.LOGTO_WEBHOOK_SIGNING_KEY,

      // Casdoor
      CASDOOR_WEBHOOK_SECRET: process.env.CASDOOR_WEBHOOK_SECRET,

      JWKS_KEY: process.env.JWKS_KEY,
      ENABLE_OIDC: !!process.env.JWKS_KEY,

      // Internal JWT expiration time
      INTERNAL_JWT_EXPIRATION: process.env.INTERNAL_JWT_EXPIRATION,
    },
  });
};

/**
 * Deployment-wide SSO variables that no longer exist: each tenant configures
 * its SSO in Admin (`sso_providers`). The built-in presets under
 * `src/libs/better-auth/sso` keep their upstream `checkEnvs`, which name these
 * variables; nothing calls it (`src/libs/better-auth/tenant-sso.ts` hands each
 * preset the tenant's credentials), and they are typed as never set, so no
 * value can come from the environment.
 */
type RetiredSsoEnvName =
  | 'AUTH_SSO_PROVIDERS'
  | 'AUTH_APPLE_APP_BUNDLE_IDENTIFIER'
  | 'AUTH_APPLE_CLIENT_ID'
  | 'AUTH_APPLE_CLIENT_SECRET'
  | 'AUTH_AUTH0_ID'
  | 'AUTH_AUTH0_ISSUER'
  | 'AUTH_AUTH0_SECRET'
  | 'AUTH_AUTHELIA_ID'
  | 'AUTH_AUTHELIA_ISSUER'
  | 'AUTH_AUTHELIA_SECRET'
  | 'AUTH_AUTHENTIK_ID'
  | 'AUTH_AUTHENTIK_ISSUER'
  | 'AUTH_AUTHENTIK_SECRET'
  | 'AUTH_CASDOOR_ID'
  | 'AUTH_CASDOOR_ISSUER'
  | 'AUTH_CASDOOR_SECRET'
  | 'AUTH_CLOUDFLARE_ZERO_TRUST_ID'
  | 'AUTH_CLOUDFLARE_ZERO_TRUST_ISSUER'
  | 'AUTH_CLOUDFLARE_ZERO_TRUST_SECRET'
  | 'AUTH_COGNITO_DOMAIN'
  | 'AUTH_COGNITO_ID'
  | 'AUTH_COGNITO_REGION'
  | 'AUTH_COGNITO_SECRET'
  | 'AUTH_COGNITO_USERPOOL_ID'
  | 'AUTH_FEISHU_APP_ID'
  | 'AUTH_FEISHU_APP_SECRET'
  | 'AUTH_GENERIC_OIDC_ID'
  | 'AUTH_GENERIC_OIDC_ISSUER'
  | 'AUTH_GENERIC_OIDC_SECRET'
  | 'AUTH_GITHUB_ID'
  | 'AUTH_GITHUB_SECRET'
  | 'AUTH_GOOGLE_ID'
  | 'AUTH_GOOGLE_SECRET'
  | 'AUTH_KEYCLOAK_ID'
  | 'AUTH_KEYCLOAK_ISSUER'
  | 'AUTH_KEYCLOAK_SECRET'
  | 'AUTH_LOGTO_ID'
  | 'AUTH_LOGTO_ISSUER'
  | 'AUTH_LOGTO_SECRET'
  | 'AUTH_MICROSOFT_AUTHORITY_URL'
  | 'AUTH_MICROSOFT_ID'
  | 'AUTH_MICROSOFT_SECRET'
  | 'AUTH_MICROSOFT_TENANT_ID'
  | 'AUTH_OKTA_ID'
  | 'AUTH_OKTA_ISSUER'
  | 'AUTH_OKTA_SECRET'
  | 'AUTH_WECHAT_ID'
  | 'AUTH_WECHAT_SECRET'
  | 'AUTH_ZITADEL_ID'
  | 'AUTH_ZITADEL_ISSUER'
  | 'AUTH_ZITADEL_SECRET';

export const authEnv = getAuthConfig() as ReturnType<typeof getAuthConfig> & {
  readonly [K in RetiredSsoEnvName]?: undefined;
};

// Auth headers and constants
export const LOBE_CHAT_AUTH_HEADER = 'X-lobe-chat-auth';
export const LOBE_CHAT_OIDC_AUTH_HEADER = 'Oidc-Auth';
