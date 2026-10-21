import type { SafeReadinessDiagnosticCode } from '@lobechat/database/tenant';

import type { DestructionRecord, DrainResult } from '@/server/modules/Tenant/destruction';

import type {
  DatasourceBundle,
  FreezeReason,
  LifecycleRequest,
  LifecycleStatus,
  ProvisionStatus,
  SafeErrorCode,
  TenantState,
} from './contracts';

/**
 * Persistence the control plane needs (spec FR-CP-09). The Postgres
 * implementation maps these onto `public.tenant_provision_operation`,
 * `public.tenant_directory`, `public.tenant_lifecycle` and
 * `public.tenant_lifecycle_inbox`; the in-memory one backs the tests.
 *
 * Records are secret-free so they can be returned, compared and logged.
 * Credential bundles (which carry passwords) only move through the dedicated
 * bundle accessors; the Postgres implementation stores them encrypted.
 */

/** Provision steps in execution order (FR-CP-04). Every step is idempotent. */
export const PROVISION_STEPS = [
  'validate',
  'ownership',
  'migrate',
  'seed',
  'directory',
  'verify',
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

export interface ProvisionOperationRecord {
  attempts: number;
  credentialBundleVersion: number | null;
  datasourceReady: boolean;
  diagnosticCode?: SafeReadinessDiagnosticCode | null;
  errorCode: SafeErrorCode | null;
  inputHash: string;
  /** Only this attempt may persist progress until the renewable step lease expires. */
  leaseToken?: string | null;
  leaseUntil?: string | null;
  name: string;
  operationId: string;
  schemaName: string | null;
  schemaVersion: number | null;
  slug: string;
  status: ProvisionStatus;
  /** The step to run next, or the one that failed; resuming starts here. */
  step: ProvisionStep;
  tenantId: string;
}

/** `public.tenant_directory` without its encrypted secrets. */
export interface TenantDirectoryRecord {
  connectionVersion: number;
  credentialBundleVersion: number;
  name: string;
  schemaName: string;
  schemaVersion: number;
  /** URL name; fixed once registered (FR-CP-09). */
  slug: string;
  status: 'provisioning' | 'active' | 'disabled';
  tenantId: string;
}

export interface TenantLifecycleRecord {
  acceptedVersion: number;
  appliedVersion: number;
  desiredState: TenantState;
  expiresAt: string | null;
  freezeReasons: FreezeReason[];
  tenantId: string;
}

export interface LifecycleEventRecord {
  attempts: number;
  errorCode: SafeErrorCode | null;
  eventId: string;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  observedAt: string;
  payloadHash: string;
  request: LifecycleRequest;
  status: LifecycleStatus;
  tenantId: string;
  version: number;
}

/** What a destruction drain can see of work that was running when the barrier was established. */
export interface DrainObservation {
  /** Incomplete external-work records: they lost the right to write at the barrier, so they fence. */
  externalWork: boolean;
  /** Provision operations and lifecycle events whose execution lease is still live. */
  liveOperations: number;
  /** A live runtime process has not yet dropped the tenant and released its pinned requests. */
  processes: boolean;
}

/** Result of one unregister item, named by tenant-destruction.json `unregisterItems.lobehub`. */
export interface UnregisterItem {
  item: string;
  result: 'absent' | 'deleted' | 'detached' | 'retained';
}

/** Reads and writes inside one transaction. */
export interface ControlPlaneTx {
  /** Establishes the terminal unless one exists, and returns the stored one (never a different id's). */
  createDestruction: (
    tenantId: string,
    destroyOperationId: string,
    terminalEstablishedAt: string,
  ) => Promise<DestructionRecord>;
  /** Revokes the execution leases of in-flight operations and events, so none can still own a write. */
  fenceInFlight: (tenantId: string) => Promise<void>;
  findEventByVersion: (tenantId: string, version: number) => Promise<LifecycleEventRecord | null>;
  /** The tenant that registered `slug`, if any. Slugs never move between tenants. */
  findTenantBySlug: (slug: string) => Promise<string | null>;
  /** Sets the drain result once; a result already set never changes. */
  finishDrain: (tenantId: string, result: DrainResult) => Promise<DestructionRecord>;
  getDestruction: (tenantId: string) => Promise<DestructionRecord | null>;
  /** The tenant's directory record and its decrypted bundle, if registered. */
  getDirectory: (
    tenantId: string,
  ) => Promise<{ bundle: DatasourceBundle; record: TenantDirectoryRecord } | null>;
  getEvent: (eventId: string) => Promise<LifecycleEventRecord | null>;
  getLifecycle: (tenantId: string) => Promise<TenantLifecycleRecord | null>;
  getOperation: (operationId: string) => Promise<ProvisionOperationRecord | null>;
  /** The bundle a provision operation was received with, until the operation applies. */
  getOperationBundle: (operationId: string) => Promise<DatasourceBundle | null>;
  listOpenEvents: (tenantId: string) => Promise<LifecycleEventRecord[]>;
  listOperations: (tenantId: string) => Promise<ProvisionOperationRecord[]>;
  observeDrain: (tenantId: string, now: Date) => Promise<DrainObservation>;
  putDirectory: (record: TenantDirectoryRecord, bundle: DatasourceBundle) => Promise<void>;
  putEvent: (record: LifecycleEventRecord) => Promise<void>;
  putLifecycle: (record: TenantLifecycleRecord) => Promise<void>;
  putOperation: (record: ProvisionOperationRecord) => Promise<void>;
  /** Stores (`bundle`) or drops (`null`) the operation's pending bundle. */
  putOperationBundle: (operationId: string, bundle: DatasourceBundle | null) => Promise<void>;
  /** Checked under the tenant control lock immediately before applied. */
  /** Why the tenant cannot be certified stopped yet, or null when it is. */
  tenantStopBlocker: (tenantId: string) => Promise<'LIFECYCLE_STOP_UNCONFIRMED' | null>;
  /**
   * Removes the tenant's platform catalog entries in one step and writes `completedAt` with the last
   * deletion. `pool` is the result of retiring this process's connection pools, which is not stored.
   */
  unregisterTenant: (
    tenantId: string,
    completedAt: string,
    pool: 'absent' | 'deleted',
  ) => Promise<UnregisterItem[]>;
}

export interface TransactionOptions {
  /**
   * The destruction phases themselves. Every other transaction is refused with TENANT_DESTROYED when
   * the tenant UUID has a destruction terminal (read under the same tenant lock the barrier holds),
   * so a request that passed its entry check before the barrier fails when it reaches its own write.
   */
  destruction?: boolean;
}

export interface ControlPlaneRepository {
  /** Never locks, writes or waits: the status query. */
  readDestruction: (tenantId: string) => Promise<DestructionRecord | null>;
  /**
   * Runs `fn` atomically. Implementations must serialise transactions that
   * touch the same tenant (Postgres: `SELECT … FOR UPDATE` on the tenant's
   * lifecycle row, or a transaction-scoped advisory lock).
   */
  transaction: <T>(
    tenantId: string,
    fn: (tx: ControlPlaneTx) => Promise<T>,
    options?: TransactionOptions,
  ) => Promise<T>;
}
