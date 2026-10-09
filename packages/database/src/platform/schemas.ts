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

/**
 * Platform tables in `public` (spec A15, FR-CP-09): only what answers "which
 * tenant does this request address, and where is its database". No account,
 * session, business configuration or business log lives here. Only the
 * platform connection (`DATABASE_URL`) can reach them; tenant runtime roles
 * have no privilege on `public` (AC-04-3).
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * One row per provisioned tenant. Non-secret connection fields are columns;
 * the two passwords are sealed with the directory key derived from
 * `KEY_VAULTS_SECRET` (spec A18), AAD
 * `tenantId|lobehub|credentialBundleVersion|<runtime|owner>`.
 */
export const tenantDirectory = pgTable(
  'tenant_directory',
  {
    connectionVersion: integer('connection_version').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    credentialBundleVersion: integer('credential_bundle_version').notNull(),
    database: text('database').notNull(),
    deploymentRef: text('deployment_ref').notNull(),
    host: text('host').notNull(),
    mode: text('mode').$type<'dedicated_database' | 'shared_schema'>().notNull(),
    name: text('name').notNull(),
    ownerSecret: text('owner_secret').notNull(),
    ownerUsername: text('owner_username').notNull(),
    port: integer('port').notNull(),
    runtimeSecret: text('runtime_secret').notNull(),
    runtimeUsername: text('runtime_username').notNull(),
    schemaName: text('schema_name').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    slug: text('slug').notNull(),
    status: text('status').$type<'active' | 'disabled' | 'provisioning'>().notNull(),
    tenantId: text('tenant_id').primaryKey(),
    tls: jsonb('tls')
      .$type<{ ca?: string; enabled: boolean; rejectUnauthorized: boolean }>()
      .notNull(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('tenant_directory_slug_idx').on(t.slug),
    uniqueIndex('tenant_directory_schema_name_idx').on(t.schemaName),
  ],
);

export const tenantLifecycle = pgTable(
  'tenant_lifecycle',
  {
    acceptedVersion: integer('accepted_version').notNull().default(0),
    appliedVersion: integer('applied_version').notNull().default(0),
    desiredState: text('desired_state').$type<'active' | 'frozen' | 'offline'>().notNull(),
    expiresAt: timestamptz('expires_at'),
    freezeReasons: jsonb('freeze_reasons')
      .$type<('expired' | 'manual' | 'security')[]>()
      .notNull()
      .default([]),
    tenantId: text('tenant_id').primaryKey(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('tenant_lifecycle_applied_le_accepted', sql`${t.appliedVersion} <= ${t.acceptedVersion}`),
  ],
);

export const tenantLifecycleInbox = pgTable(
  'tenant_lifecycle_inbox',
  {
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    errorCode: text('error_code'),
    eventId: text('event_id').primaryKey(),
    leaseToken: text('lease_token'),
    leaseUntil: timestamptz('lease_until'),
    observedAt: timestamptz('observed_at').notNull(),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').notNull(),
    tenantId: text('tenant_id').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [
    uniqueIndex('tenant_lifecycle_inbox_tenant_version_idx').on(t.tenantId, t.version),
    index('tenant_lifecycle_inbox_status_idx').on(t.status),
  ],
);

export const tenantProvisionOperation = pgTable(
  'tenant_provision_operation',
  {
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    credentialBundleVersion: integer('credential_bundle_version'),
    datasourceReady: boolean('datasource_ready').notNull().default(false),
    errorCode: text('error_code'),
    inputHash: text('input_hash').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: timestamptz('lease_until'),
    name: text('name').notNull(),
    operationId: text('operation_id').primaryKey(),
    /**
     * The bundle the operation was received with, sealed with the directory
     * key, until the operation applies and the directory holds it.
     */
    pendingBundle: text('pending_bundle'),
    schemaName: text('schema_name'),
    schemaVersion: integer('schema_version'),
    slug: text('slug').notNull(),
    status: text('status').notNull(),
    step: text('step').notNull(),
    tenantId: text('tenant_id').notNull(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('tenant_provision_operation_tenant_idx').on(t.tenantId),
    index('tenant_provision_operation_slug_idx').on(t.slug),
    index('tenant_provision_operation_status_idx').on(t.status),
  ],
);
