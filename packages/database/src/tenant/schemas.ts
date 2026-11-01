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

import type { SsoOAuth2Config, SsoOidcConfig } from './ssoTypes';

/**
 * Tables only a tenant schema has. They stay out of `../schemas` so the shared
 * drizzle chain never generates them; their DDL is the tenant-only chain in
 * `migrations/tenant`, which runs after the shared one (`./migrator.ts`).
 *
 * That includes the fork's private models in `../privateSchemas` (command
 * governance, Channel, and sub-agent bridges), re-exported below: this file is the entry of the
 * tenant chain's drizzle config, and the chain is the only place their DDL lives.
 * The re-export serves that entry and the readiness check (`import * as`); import
 * the models by name from `@lobechat/database/privateSchemas`, whose explicit
 * exports ES modules can see (an `export *` hides every name from them).
 */

/**
 * The tenant's SSO providers (spec A8, FR-ID-09). Admin is the only writer: it
 * upserts the whole row on create / update / enable / delete (delete is a soft
 * delete that nulls `secret_config_encrypted`). LobeHub only reads it.
 *
 * Columns match Admin's `tenantSsoProviders` and its LobeHub mirror
 * (`instance/lobehub/schemas/sso.ts`) exactly. `secret_config_encrypted` is a
 * `v1.<iv>.<ciphertext>.<tag>` envelope sealed with the tenant data key
 * (spec A18), AAD `tenantId|providerId|revision`. Only OIDC and generic OAuth 2.0
 * (`preset: 'custom'`) are supported; SAML and named OAuth2 vendors are retired.
 */
export const ssoProviders = pgTable(
  'sso_providers',
  {
    admissionPolicy: text('admission_policy').default('allowlist').notNull(),
    bridgeConfig: text('bridge_config'),
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
  ],
);

export type SsoProviderItem = typeof ssoProviders.$inferSelect;

export * from '../privateSchemas';
