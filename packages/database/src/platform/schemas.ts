import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type { TenantMemberBudget } from '../tenant/migrator';

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
    /** Profile (name, slug, aliases) revision; provision itself is version 1. */
    profileVersion: integer('profile_version').notNull().default(1),
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

/**
 * Slugs a tenant used to have. They keep resolving to the same tenant (pages are redirected to the
 * current slug) and never belong to another one. A slug is either a directory slug or an alias, never
 * both: the two unique indexes cannot see each other, so the control plane checks under a lock.
 */
export const tenantSlugAlias = pgTable(
  'tenant_slug_alias',
  {
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    slug: text('slug').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenantDirectory.tenantId, { onDelete: 'cascade' }),
  },
  (t) => [index('tenant_slug_alias_tenant_idx').on(t.tenantId)],
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
    diagnosticCode: text('diagnostic_code'),
    errorCode: text('error_code'),
    inputHash: text('input_hash').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: timestamptz('lease_until'),
    /** Root department per-member budget the request carried; null means no limit. */
    memberBudget: jsonb('member_budget').$type<TenantMemberBudget>(),
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

/** One expiring lease per process. A missing generation report is never a drain receipt. */
export const tenantRuntimeProcess = pgTable('tenant_runtime_process', {
  processId: text('process_id').primaryKey(),
  startedAt: timestamptz('started_at').notNull().defaultNow(),
  heartbeatAt: timestamptz('heartbeat_at').notNull().defaultNow(),
  leaseExpiresAt: timestamptz('lease_expires_at').notNull().defaultNow(),
  drainedGenerations: jsonb('drained_generations')
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
});

/** Remote jobs outlive their originating process; retirement must never erase them. */
export const tenantRuntimeExternalWork = pgTable(
  'tenant_runtime_external_work',
  {
    workId: text('work_id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    kind: text('kind').notNull(),
    handle: text('handle'),
    context: jsonb('context').$type<Record<string, unknown>>(),
    completedAt: timestamptz('completed_at'),
    receipt: jsonb('receipt').$type<Record<string, unknown>>(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('tenant_runtime_external_work_tenant_idx').on(t.tenantId)],
);

/** Public entry projection, independently versioned from lifecycle and datasource. */
export const tenantEndpointState = pgTable(
  'tenant_endpoint_state',
  {
    tenantId: text('tenant_id')
      .primaryKey()
      .references(() => tenantDirectory.tenantId),
    acceptedVersion: integer('accepted_version').notNull(),
    appliedVersion: integer('applied_version').notNull(),
    observedAt: timestamptz('observed_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'tenant_endpoint_version_positive',
      sql`${t.appliedVersion} > 0 AND ${t.appliedVersion} = ${t.acceptedVersion}`,
    ),
  ],
);

export const tenantEndpoints = pgTable(
  'tenant_endpoints',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenantDirectory.tenantId),
    id: text('id').notNull(),
    kind: text('kind').$type<'default' | 'custom'>().notNull(),
    host: text('host'),
    active: boolean('active').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    uniqueIndex('tenant_endpoints_host_idx').on(t.host),
    uniqueIndex('tenant_endpoints_active_idx')
      .on(t.tenantId)
      .where(sql`${t.active}`),
    check(
      'tenant_endpoints_kind_valid',
      sql`(${t.kind} = 'default' AND ${t.id} = 'default' AND ${t.host} IS NULL) OR (${t.kind} = 'custom' AND ${t.id} <> 'default' AND ${t.host} IS NOT NULL)`,
    ),
  ],
);

export const tenantEndpointEvents = pgTable(
  'tenant_endpoint_events',
  {
    eventId: text('event_id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenantDirectory.tenantId),
    version: integer('version').notNull(),
    payloadHash: text('payload_hash').notNull(),
  },
  (t) => [uniqueIndex('tenant_endpoint_events_version_idx').on(t.tenantId, t.version)],
);

/**
 * The durable destruction terminal, one row per tenant UUID (contracts/tenant-control-plane/
 * tenant-destruction.json `terminalRecord`). Deliberately standalone: no foreign key and no cascade, so
 * it survives deleting the directory entry, the connection, the credentials and every operation of
 * the tenant. It holds no slug, name, credential or actor, so it never reserves a slug: a new tenant
 * with the same slug gets a new UUID and is unaffected. Nothing removes a row in this release.
 *
 * `completedAt` is the only proof that the destruction is complete; a row without it means the
 * destruction is in progress and every phase of the same `destroyOperationId` can still be asked for.
 */
export const tenantDestruction = pgTable(
  'tenant_destruction',
  {
    completedAt: timestamptz('completed_at'),
    destroyOperationId: text('destroy_operation_id').notNull(),
    drainResult: text('drain_result').$type<'drained' | 'fenced'>(),
    tenantId: text('tenant_id').primaryKey(),
    terminalEstablishedAt: timestamptz('terminal_established_at').notNull(),
  },
  (t) => [
    check(
      'tenant_destruction_drain_result_valid',
      sql`${t.drainResult} IS NULL OR ${t.drainResult} IN ('drained', 'fenced')`,
    ),
    check(
      'tenant_destruction_completed_after_drain',
      sql`${t.completedAt} IS NULL OR ${t.drainResult} IS NOT NULL`,
    ),
  ],
);
