import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { SsoOAuth2Config, SsoOidcConfig, SsoSamlConfig } from './ssoTypes';

/**
 * Tables only a tenant schema has. They stay out of `../schemas` so the shared
 * drizzle chain never generates them; their DDL is the tenant-only chain in
 * `migrations/tenant`, which runs after the shared one (`./migrator.ts`).
 */

/**
 * The tenant's SSO providers (spec A8, FR-ID-09). Admin is the only writer: it
 * upserts the whole row on create / update / enable / delete (delete is a soft
 * delete that nulls `secret_config_encrypted`). LobeHub only reads it.
 *
 * Columns match Admin's `tenantSsoProviders` and its LobeHub mirror
 * (`instance/lobehub/schemas/sso.ts`) exactly. `secret_config_encrypted` is a
 * `v1.<iv>.<ciphertext>.<tag>` envelope sealed with the tenant data key
 * (spec A18), AAD `tenantId|providerId|revision`. `saml_config` carries no
 * `callbackUrl` / `spMetadata`; LobeHub derives its own ACS and SP entity ID.
 */
export const ssoProviders = pgTable(
  'sso_providers',
  {
    admissionPolicy: text('admission_policy').default('allowlist').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    displayName: text('display_name').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    id: text('id').primaryKey(),
    issuer: text('issuer').notNull(),
    logoUrl: text('logo_url'),
    oauth2Config: jsonb('oauth2_config').$type<SsoOAuth2Config>(),
    oidcConfig: jsonb('oidc_config').$type<SsoOidcConfig>(),
    protocol: text('protocol').notNull(),
    providerId: text('provider_id').notNull(),
    revision: integer('revision').default(1).notNull(),
    samlConfig: jsonb('saml_config').$type<SsoSamlConfig>(),
    secretConfigEncrypted: text('secret_config_encrypted'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('sso_providers_provider_id_idx').on(table.providerId),
    index('sso_providers_enabled_idx').on(table.enabled),
    check(
      'sso_providers_oauth2_config_object',
      sql`jsonb_typeof(${table.oauth2Config}) = 'object'`,
    ),
    check('sso_providers_oidc_config_object', sql`jsonb_typeof(${table.oidcConfig}) = 'object'`),
    check('sso_providers_saml_config_object', sql`jsonb_typeof(${table.samlConfig}) = 'object'`),
  ],
);

export type SsoProviderItem = typeof ssoProviders.$inferSelect;
