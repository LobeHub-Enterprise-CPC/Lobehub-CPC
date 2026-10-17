import type { SafeReadinessDiagnosticCode } from '@lobechat/database/tenant';
import { z } from 'zod';

/**
 * Wire contract for `/api/internal/control-plane/*` (spec FR-CP-01..07).
 *
 * Console `src/server/controlPlane/contracts.ts` is the caller and the source of
 * truth: field names, limits and enums here must match it field by field.
 */

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:-]+$/);
const version = z.number().int().positive().max(2_147_483_647);
const date = z.string().datetime({ offset: true });

/** The only error codes Console passes through; anything else shows as UPSTREAM_FAILED. */
export const SAFE_ERROR_CODES = [
  'TOKEN_INVALID',
  'TENANT_MISMATCH',
  'TENANT_INVALID',
  'TENANT_PROVISION_FAILED',
  'TENANT_NOT_READY',
  'TENANT_NOT_FOUND',
  'VERSION_CONFLICT',
  'DATASOURCE_INVALID',
  'DATASOURCE_VERSION_CONFLICT',
  'CREDENTIALS_UNAVAILABLE',
  'LIFECYCLE_FAILED',
  'LIFECYCLE_STOP_UNCONFIRMED',
  'LIFECYCLE_STOP_FAILED',
  'LIFECYCLE_DRAIN_FAILED',
  'LIFECYCLE_RESUME_FAILED',
  'LIFECYCLE_EVENT_CONFLICT',
  'LIFECYCLE_VERSION_CONFLICT',
] as const;
export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

/**
 * Why a lifecycle event failed (`errorCode` of a failed result). Admin returns the same codes and
 * Console maps them to operator guidance (docs/tenant-control-plane.md). `action_required` needs
 * an operator before a retry can succeed: a failed POST answers it with 409, the rest with 503.
 * Must match contracts/tenant-control-plane/lifecycle-failure-codes.json (owned by Console, copied
 * byte-identically here); a unit test binds this table to it.
 */
export const LIFECYCLE_FAILURE_CODES = {
  LIFECYCLE_DRAIN_FAILED: 'retryable',
  LIFECYCLE_FAILED: 'retryable',
  LIFECYCLE_RESUME_FAILED: 'retryable',
  LIFECYCLE_STOP_FAILED: 'retryable',
  LIFECYCLE_STOP_UNCONFIRMED: 'retryable',
  TENANT_NOT_READY: 'retryable',
} as const satisfies Partial<Record<SafeErrorCode, 'action_required' | 'retryable'>>;
export type LifecycleFailureCode = keyof typeof LIFECYCLE_FAILURE_CODES;
export const isActionRequired = (code: string | null | undefined) =>
  !!code && (LIFECYCLE_FAILURE_CODES as Record<string, string>)[code] === 'action_required';

/** A lifecycle phase that failed for a known reason; recorded on the event, never as text. */
export class LifecycleFailure extends Error {
  constructor(readonly code: LifecycleFailureCode) {
    super(code);
    this.name = 'LifecycleFailure';
  }
}

const roleName = z
  .string()
  .max(63)
  .regex(/^[_a-z][\d_a-z]*$/);

/**
 * The credential bundle Console builds after creating the tenant's schema and
 * roles (spec FR-CP-05). Mirrors Console `bundleSchema` field by field,
 * including its refine; the derivation and host checks live in `datasource.ts`
 * so a bad bundle becomes a recorded `DATASOURCE_INVALID`, not a 400.
 */
export const datasourceBundleSchema = z
  .object({
    connectionVersion: version,
    credentialBundleVersion: version,
    database: z.string().min(1).max(63),
    datasourceKind: z.enum(['admin', 'lobehub']),
    deploymentRef: id,
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[\d.:a-z-]+$/i),
    mode: z.enum(['shared_schema', 'dedicated_database']),
    port: z.number().int().min(1).max(65_535),
    runtimeCredential: z.object({
      password: z.string().min(1).max(4096),
      username: roleName,
    }),
    schemaName: z
      .string()
      .max(63)
      .regex(/^tenant_[\d_a-z]+$/),
    schemaOwner: z.object({
      password: z.string().min(1).max(4096),
      role: roleName,
      username: roleName,
    }),
    schemaVersion: version,
    tenantId: id,
    tls: z.object({
      ca: z.string().max(32_768).optional(),
      enabled: z.boolean(),
      rejectUnauthorized: z.boolean(),
    }),
  })
  .refine(
    (v) =>
      v.schemaOwner.username !== v.runtimeCredential.username &&
      v.schemaOwner.role !== v.runtimeCredential.username,
    'RUNTIME_OWNER_CONFLICT',
  );
export type DatasourceBundle = z.infer<typeof datasourceBundleSchema>;

/** Readiness binds the current datasource without transmitting either password. */
export const datasourceBindingSchema = z
  .object({
    ...datasourceBundleSchema.shape,
    runtimeCredential: z.object({ username: roleName }).strict(),
    schemaOwner: z.object({ role: roleName, username: roleName }).strict(),
  })
  .strict();
export const datasourceReadinessRequestSchema = z
  .object({
    datasource: datasourceBindingSchema,
    tenantId: id,
  })
  .strict();
export type DatasourceReadinessRequest = z.infer<typeof datasourceReadinessRequestSchema>;
export interface DatasourceReadinessResult {
  checkedAt: string;
  connectionVersion: number;
  credentialBundleVersion: number;
  datasourceReady: boolean;
  diagnosticCode?: SafeReadinessDiagnosticCode | null;
  errorCode: SafeErrorCode | null;
  schemaName: string;
  schemaVersion: number;
  tenantId: string;
}

export const provisionRequestSchema = z
  .object({
    datasource: datasourceBundleSchema,
    name: z.string().trim().min(1).max(256),
    operationId: id,
    rootOperationId: id,
    // Slug rules are checked by the service so a bad slug becomes a recorded
    // `failed` result (FR-CP-04 §4), not a 400 Console would retry forever.
    slug: z.string().min(1).max(63),
    tenantId: id,
  })
  .strict();
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

export const provisionQuerySchema = z.object({ operationId: id, tenantId: id }).strict();

export type ProvisionStatus = 'received' | 'applying' | 'applied' | 'failed';

export interface ProvisionResult {
  credentialBundleVersion: number | null;
  datasourceReady: boolean;
  diagnosticCode?: SafeReadinessDiagnosticCode | null;
  errorCode: SafeErrorCode | null;
  operationId: string;
  schemaName: string | null;
  schemaVersion: number | null;
  status: ProvisionStatus;
  tenantId: string;
}

/** Credential rotation / connection move pushed by Console (FR-CP-05). */
export const datasourceRequestSchema = z
  .object({ datasource: datasourceBundleSchema, operationId: id, tenantId: id })
  .strict();
export type DatasourceRequest = z.infer<typeof datasourceRequestSchema>;

export interface DatasourceResult {
  connectionVersion: number;
  credentialBundleVersion: number;
  datasourceKind: 'lobehub';
  diagnosticCode?: SafeReadinessDiagnosticCode | null;
  errorCode: SafeErrorCode | null;
  operationId: string;
  status: 'applied' | 'failed';
  tenantId: string;
}

export const freezeReasonSchema = z.enum(['manual', 'security', 'expired']);
export type FreezeReason = z.infer<typeof freezeReasonSchema>;
export const tenantStateSchema = z.enum(['active', 'frozen', 'offline']);
export type TenantState = z.infer<typeof tenantStateSchema>;

export const lifecycleRequestSchema = z
  .object({
    desiredState: tenantStateSchema,
    eventId: id,
    expiresAt: date.nullable(),
    freezeReasons: z.array(freezeReasonSchema).max(3),
    occurredAt: date,
    tenantId: id,
    version,
  })
  .strict()
  .refine((v) => new Set(v.freezeReasons).size === v.freezeReasons.length, 'DUPLICATE_REASON')
  .refine(
    (v) =>
      v.desiredState !== 'active' ||
      !v.freezeReasons.some((r) => r === 'manual' || r === 'security'),
    'ACTIVE_WITH_FREEZE_REASON',
  );
export type LifecycleRequest = z.infer<typeof lifecycleRequestSchema>;

export const lifecycleQuerySchema = z.object({ eventId: id, tenantId: id }).strict();
export const overviewQuerySchema = z.object({ tenantId: id }).strict();

export type LifecycleStatus = 'received' | 'applying' | 'applied' | 'failed' | 'superseded';

export interface LifecycleResult {
  acceptedVersion: number;
  appliedVersion: number;
  errorCode: SafeErrorCode | null;
  eventId: string;
  observedAt: string;
  status: LifecycleStatus;
  tenantId: string;
  version: number;
}

export interface TenantOverview {
  acceptedVersion: number;
  appliedVersion: number;
  desiredState: TenantState;
  effectiveState: TenantState;
  expiresAt: string | null;
  freezeReasons: FreezeReason[];
  observedAt: string;
  readiness: 'pending' | 'applying' | 'ready' | 'failed';
  slug: string;
  tenantId: string;
}

/**
 * A refusal the router turns into `{ code }` with `status`. `code` is either a
 * safe code or one of the transport-level codes FR-CP-03 lists.
 */
export class ControlPlaneError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
    readonly code: SafeErrorCode | 'INVALID_INPUT' | 'NOT_FOUND' | 'REQUEST_TOO_LARGE' | 'INTERNAL',
  ) {
    super(code);
    this.name = 'ControlPlaneError';
  }
}
