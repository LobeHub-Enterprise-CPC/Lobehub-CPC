import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Tables only a tenant schema has. They stay out of `../schemas` so the shared
 * drizzle chain never generates them; their DDL is the tenant-only chain in
 * `migrations/tenant`, which runs after the shared one (`./migrator.ts`).
 */

/**
 * The tenant marker (spec A4, FR-DI-04): one row
 * `(tenant_id, 'lobehub', schema_version)` written by the provision `marker`
 * step as the schema owner. The runtime role only has SELECT on it; the
 * resolver and Admin's LobeHub session read it to prove a connection really
 * points at the tenant it was registered for.
 */
export const tenantMetadata = pgTable('tenant_metadata', {
  datasourceKind: text('datasource_kind').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  schemaVersion: text('schema_version').notNull(),
  tenantId: text('tenant_id').primaryKey(),
});

export type TenantMetadataItem = typeof tenantMetadata.$inferSelect;

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
    oauth2Config: text('oauth2_config'),
    oidcConfig: text('oidc_config'),
    protocol: text('protocol').notNull(),
    providerId: text('provider_id').notNull(),
    revision: integer('revision').default(1).notNull(),
    samlConfig: text('saml_config'),
    secretConfigEncrypted: text('secret_config_encrypted'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('sso_providers_provider_id_idx').on(table.providerId),
    index('sso_providers_enabled_idx').on(table.enabled),
  ],
);

export type SsoProviderItem = typeof ssoProviders.$inferSelect;
