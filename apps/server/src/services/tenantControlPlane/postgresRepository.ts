import type { PlatformDatabase } from '@lobechat/database/platform';
import {
  tenantDirectory,
  tenantLifecycle,
  tenantLifecycleInbox,
  tenantProvisionOperation,
} from '@lobechat/database/platform';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { openDirectoryData, sealDirectoryData } from '@/server/crypto/tenantKeys';

import type { DatasourceBundle, LifecycleRequest, SafeErrorCode } from './contracts';
import type {
  ControlPlaneRepository,
  ControlPlaneTx,
  LifecycleEventRecord,
  ProvisionOperationRecord,
  ProvisionStep,
  TenantDirectoryRecord,
  TenantLifecycleRecord,
} from './repository';

/**
 * The control plane's state in the platform database (spec FR-CP-09).
 *
 * Passwords never sit in a column in clear: the two directory passwords and
 * an operation's pending bundle are sealed with the directory key derived from
 * `KEY_VAULTS_SECRET` (spec A18). The AAD binds each ciphertext to its tenant,
 * bundle version and role, so a sealed value cannot be moved onto another row.
 */

type Tx = Parameters<Parameters<PlatformDatabase['transaction']>[0]>[0];

export const directorySecretAad = (
  tenantId: string,
  credentialBundleVersion: number,
  role: 'owner' | 'runtime',
) => `${tenantId}|lobehub|${credentialBundleVersion}|${role}`;

const pendingBundleAad = (tenantId: string, operationId: string) =>
  `${tenantId}|lobehub|operation|${operationId}`;

type DirectoryRow = typeof tenantDirectory.$inferSelect;

/** Rebuilds the bundle from a directory row. Throws when a secret does not open. */
export const bundleFromDirectoryRow = (row: DirectoryRow): DatasourceBundle => ({
  connectionVersion: row.connectionVersion,
  credentialBundleVersion: row.credentialBundleVersion,
  database: row.database,
  datasourceKind: 'lobehub',
  deploymentRef: row.deploymentRef,
  host: row.host,
  mode: row.mode,
  port: row.port,
  runtimeCredential: {
    password: openDirectoryData(
      row.runtimeSecret,
      directorySecretAad(row.tenantId, row.credentialBundleVersion, 'runtime'),
    ),
    username: row.runtimeUsername,
  },
  schemaName: row.schemaName,
  schemaOwner: {
    password: openDirectoryData(
      row.ownerSecret,
      directorySecretAad(row.tenantId, row.credentialBundleVersion, 'owner'),
    ),
    role: row.ownerUsername,
    username: row.ownerUsername,
  },
  schemaVersion: row.schemaVersion,
  tenantId: row.tenantId,
  tls: row.tls,
});

export const directoryRecordFromRow = (row: DirectoryRow): TenantDirectoryRecord => ({
  connectionVersion: row.connectionVersion,
  credentialBundleVersion: row.credentialBundleVersion,
  name: row.name,
  schemaName: row.schemaName,
  schemaVersion: row.schemaVersion,
  slug: row.slug,
  status: row.status,
  tenantId: row.tenantId,
});

type OperationRow = typeof tenantProvisionOperation.$inferSelect;
const toOperation = (row: OperationRow): ProvisionOperationRecord => ({
  attempts: row.attempts,
  credentialBundleVersion: row.credentialBundleVersion,
  datasourceReady: row.datasourceReady,
  errorCode: row.errorCode as SafeErrorCode | null,
  inputHash: row.inputHash,
  name: row.name,
  operationId: row.operationId,
  schemaName: row.schemaName,
  schemaVersion: row.schemaVersion,
  slug: row.slug,
  status: row.status as ProvisionOperationRecord['status'],
  step: row.step as ProvisionStep,
  tenantId: row.tenantId,
});

type EventRow = typeof tenantLifecycleInbox.$inferSelect;
const toEvent = (row: EventRow): LifecycleEventRecord => ({
  attempts: row.attempts,
  errorCode: row.errorCode as SafeErrorCode | null,
  eventId: row.eventId,
  observedAt: row.observedAt.toISOString(),
  payloadHash: row.payloadHash,
  request: row.payload as LifecycleRequest,
  status: row.status as LifecycleEventRecord['status'],
  tenantId: row.tenantId,
  version: row.version,
});

type LifecycleRow = typeof tenantLifecycle.$inferSelect;
const toLifecycle = (row: LifecycleRow): TenantLifecycleRecord => ({
  acceptedVersion: row.acceptedVersion,
  appliedVersion: row.appliedVersion,
  desiredState: row.desiredState,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  freezeReasons: row.freezeReasons,
  tenantId: row.tenantId,
});

const createTx = (tx: Tx): ControlPlaneTx => ({
  findEventByVersion: async (tenantId, version) => {
    const [row] = await tx
      .select()
      .from(tenantLifecycleInbox)
      .where(
        and(eq(tenantLifecycleInbox.tenantId, tenantId), eq(tenantLifecycleInbox.version, version)),
      )
      .limit(1);
    return row ? toEvent(row) : null;
  },

  findTenantBySlug: async (slug) => {
    const [directory] = await tx
      .select({ tenantId: tenantDirectory.tenantId })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.slug, slug))
      .limit(1);
    if (directory) return directory.tenantId;
    const [operation] = await tx
      .select({ tenantId: tenantProvisionOperation.tenantId })
      .from(tenantProvisionOperation)
      .where(eq(tenantProvisionOperation.slug, slug))
      .limit(1);
    return operation?.tenantId ?? null;
  },

  getDirectory: async (tenantId) => {
    const [row] = await tx
      .select()
      .from(tenantDirectory)
      .where(eq(tenantDirectory.tenantId, tenantId))
      .limit(1);
    return row
      ? { bundle: bundleFromDirectoryRow(row), record: directoryRecordFromRow(row) }
      : null;
  },

  getEvent: async (eventId) => {
    const [row] = await tx
      .select()
      .from(tenantLifecycleInbox)
      .where(eq(tenantLifecycleInbox.eventId, eventId))
      .limit(1);
    return row ? toEvent(row) : null;
  },

  getLifecycle: async (tenantId) => {
    const [row] = await tx
      .select()
      .from(tenantLifecycle)
      .where(eq(tenantLifecycle.tenantId, tenantId))
      .limit(1);
    return row ? toLifecycle(row) : null;
  },

  getOperation: async (operationId) => {
    const [row] = await tx
      .select()
      .from(tenantProvisionOperation)
      .where(eq(tenantProvisionOperation.operationId, operationId))
      .limit(1);
    return row ? toOperation(row) : null;
  },

  getOperationBundle: async (operationId) => {
    const [row] = await tx
      .select({
        pendingBundle: tenantProvisionOperation.pendingBundle,
        tenantId: tenantProvisionOperation.tenantId,
      })
      .from(tenantProvisionOperation)
      .where(eq(tenantProvisionOperation.operationId, operationId))
      .limit(1);
    if (!row?.pendingBundle) return null;
    return JSON.parse(
      openDirectoryData(row.pendingBundle, pendingBundleAad(row.tenantId, operationId)),
    ) as DatasourceBundle;
  },

  listOpenEvents: async (tenantId) => {
    const rows = await tx
      .select()
      .from(tenantLifecycleInbox)
      .where(
        and(
          eq(tenantLifecycleInbox.tenantId, tenantId),
          inArray(tenantLifecycleInbox.status, ['received', 'applying', 'failed']),
        ),
      );
    return rows.map(toEvent);
  },

  listOperations: async (tenantId) => {
    const rows = await tx
      .select()
      .from(tenantProvisionOperation)
      .where(eq(tenantProvisionOperation.tenantId, tenantId))
      .orderBy(tenantProvisionOperation.createdAt);
    return rows.map(toOperation);
  },

  putDirectory: async (record, bundle) => {
    const values = {
      connectionVersion: record.connectionVersion,
      credentialBundleVersion: record.credentialBundleVersion,
      database: bundle.database,
      deploymentRef: bundle.deploymentRef,
      host: bundle.host,
      mode: bundle.mode,
      name: record.name,
      ownerSecret: sealDirectoryData(
        bundle.schemaOwner.password,
        directorySecretAad(record.tenantId, record.credentialBundleVersion, 'owner'),
      ),
      ownerUsername: bundle.schemaOwner.username,
      port: bundle.port,
      runtimeSecret: sealDirectoryData(
        bundle.runtimeCredential.password,
        directorySecretAad(record.tenantId, record.credentialBundleVersion, 'runtime'),
      ),
      runtimeUsername: bundle.runtimeCredential.username,
      schemaName: record.schemaName,
      schemaVersion: record.schemaVersion,
      slug: record.slug,
      status: record.status,
      tenantId: record.tenantId,
      tls: bundle.tls,
    };
    // The slug is fixed once registered: an update never changes it.
    const { slug: _slug, tenantId: _tenantId, ...update } = values;
    await tx
      .insert(tenantDirectory)
      .values(values)
      .onConflictDoUpdate({ set: update, target: tenantDirectory.tenantId });
  },

  putEvent: async (record) => {
    const values = {
      attempts: record.attempts,
      errorCode: record.errorCode,
      eventId: record.eventId,
      observedAt: new Date(record.observedAt),
      payload: record.request,
      payloadHash: record.payloadHash,
      status: record.status,
      tenantId: record.tenantId,
      version: record.version,
    };
    const { eventId: _eventId, ...update } = values;
    await tx
      .insert(tenantLifecycleInbox)
      .values(values)
      .onConflictDoUpdate({ set: update, target: tenantLifecycleInbox.eventId });
  },

  putLifecycle: async (record) => {
    const values = {
      acceptedVersion: record.acceptedVersion,
      appliedVersion: record.appliedVersion,
      desiredState: record.desiredState,
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      freezeReasons: record.freezeReasons,
      tenantId: record.tenantId,
    };
    const { tenantId: _tenantId, ...update } = values;
    await tx
      .insert(tenantLifecycle)
      .values(values)
      .onConflictDoUpdate({ set: update, target: tenantLifecycle.tenantId });
  },

  putOperation: async (record) => {
    const values = {
      attempts: record.attempts,
      credentialBundleVersion: record.credentialBundleVersion,
      datasourceReady: record.datasourceReady,
      errorCode: record.errorCode,
      inputHash: record.inputHash,
      name: record.name,
      operationId: record.operationId,
      schemaName: record.schemaName,
      schemaVersion: record.schemaVersion,
      slug: record.slug,
      status: record.status,
      step: record.step,
      tenantId: record.tenantId,
    };
    const { operationId: _operationId, ...update } = values;
    await tx
      .insert(tenantProvisionOperation)
      .values(values)
      .onConflictDoUpdate({ set: update, target: tenantProvisionOperation.operationId });
  },

  putOperationBundle: async (operationId, bundle) => {
    const [row] = await tx
      .select({ tenantId: tenantProvisionOperation.tenantId })
      .from(tenantProvisionOperation)
      .where(eq(tenantProvisionOperation.operationId, operationId))
      .limit(1);
    if (!row) throw new Error('OPERATION_NOT_FOUND');
    await tx
      .update(tenantProvisionOperation)
      .set({
        pendingBundle: bundle
          ? sealDirectoryData(JSON.stringify(bundle), pendingBundleAad(row.tenantId, operationId))
          : null,
      })
      .where(eq(tenantProvisionOperation.operationId, operationId));
  },
});

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  constructor(private readonly db: PlatformDatabase) {}

  transaction<T>(tenantId: string, fn: (tx: ControlPlaneTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Serialises every transaction that touches this tenant's control state.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lobehub:tenant-control:${tenantId}`}, 0))`,
      );
      return fn(createTx(tx));
    });
  }
}
