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
  'marker',
  'seed',
  'directory',
  'verify',
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

export interface ProvisionOperationRecord {
  attempts: number;
  credentialBundleVersion: number | null;
  datasourceReady: boolean;
  errorCode: SafeErrorCode | null;
  inputHash: string;
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
  observedAt: string;
  payloadHash: string;
  request: LifecycleRequest;
  status: LifecycleStatus;
  tenantId: string;
  version: number;
}

/** Reads and writes inside one transaction. */
export interface ControlPlaneTx {
  findEventByVersion: (tenantId: string, version: number) => Promise<LifecycleEventRecord | null>;
  /** The tenant that registered `slug`, if any. Slugs never move between tenants. */
  findTenantBySlug: (slug: string) => Promise<string | null>;
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
  putDirectory: (record: TenantDirectoryRecord, bundle: DatasourceBundle) => Promise<void>;
  putEvent: (record: LifecycleEventRecord) => Promise<void>;
  putLifecycle: (record: TenantLifecycleRecord) => Promise<void>;
  putOperation: (record: ProvisionOperationRecord) => Promise<void>;
  /** Stores (`bundle`) or drops (`null`) the operation's pending bundle. */
  putOperationBundle: (operationId: string, bundle: DatasourceBundle | null) => Promise<void>;
}

export interface ControlPlaneRepository {
  /**
   * Runs `fn` atomically. Implementations must serialise transactions that
   * touch the same tenant (Postgres: `SELECT … FOR UPDATE` on the tenant's
   * lifecycle row, or a transaction-scoped advisory lock).
   */
  transaction: <T>(tenantId: string, fn: (tx: ControlPlaneTx) => Promise<T>) => Promise<T>;
}
