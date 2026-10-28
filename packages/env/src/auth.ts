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

// There are no deployment-wide SSO variables (`AUTH_SSO_PROVIDERS`, `AUTH_<PROVIDER>_*`): each
// tenant configures its SSO in Admin (`sso_providers`, OIDC or generic OAuth 2.0) and nothing reads
// them from the environment.
export const authEnv = getAuthConfig();

// Auth headers and constants
export const LOBE_CHAT_OIDC_AUTH_HEADER = 'Oidc-Auth';
