import type { SafeReadinessDiagnosticCode } from '@lobechat/database/tenant';
import { isTenantId, isTenantSchemaName } from '@lobechat/database/tenant';
import { isWellFormedTenantSlug } from '@lobechat/utils/tenantPath';
import { z } from 'zod';

/**
 * Wire contract for `/api/internal/control-plane/*` (spec FR-CP-01..07).
 *
 * Console `src/shared/controlPlane` is the caller and the source of truth. It publishes the
 * contract as JSON Schema and fixtures in contracts/tenant-control-plane (byte-identical copy
 * here, checked by Console's `contracts:check`); `contractFixtures.test.ts` holds these receiving
 * schemas and this application's answers to those files.
 */

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:-]+$/);
/** Console generates tenant ids as lower-case UUIDs (tenant-naming.json). */
const tenantId = z.string().refine(isTenantId, 'TENANT_ID_INVALID');
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
  'SLUG_CONFLICT',
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
  // tenant-destruction.json errors.codes: the ones Console reads from this application.
  'TENANT_DESTROYED',
  'DESTROY_PHASE_ORDER',
  'OPERATION_CONFLICT',
  'TENANT_DESTRUCTION_FAILED',
] as const;
export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

export type { LifecycleFailureCode } from '@/server/modules/Tenant/lifecycleFailure';
export {
  isActionRequired,
  LIFECYCLE_FAILURE_CODES,
  LifecycleFailure,
} from '@/server/modules/Tenant/lifecycleFailure';

/** `lh_<h24>_owner` and `lh_<h24>_run`: the LobeHub rows of tenant-naming.json `rolePatterns`. */
const ownerRole = z.string().regex(/^lh_[\da-f]{24}_owner$/);
const runtimeRole = z.string().regex(/^lh_[\da-f]{24}_run$/);

/**
 * The credential bundle Console builds after creating the tenant's schema and
 * roles (spec FR-CP-05). TITU Work migrates as the schema owner, so unlike the
 * LobeHub bundle Admin receives, this one carries the owner password. Strict, as
 * in the contract; the derivation and host checks live in `datasource.ts` so a
 * bundle for another tenant becomes a recorded `DATASOURCE_INVALID`, not a 400.
 */
export const datasourceBundleSchema = z
  .object({
    connectionVersion: version,
    credentialBundleVersion: version,
    database: z.string().min(1).max(63),
    datasourceKind: z.literal('lobehub'),
    deploymentRef: id,
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[\d.:a-z-]+$/i),
    mode: z.enum(['shared_schema', 'dedicated_database']),
    port: z.number().int().min(1).max(65_535),
    runtimeCredential: z
      .object({ password: z.string().min(1).max(4096), username: runtimeRole })
      .strict(),
    schemaName: z.string().refine(isTenantSchemaName, 'SCHEMA_NAME_INVALID'),
    schemaOwner: z
      .object({
        password: z.string().min(1).max(4096),
        role: ownerRole,
        username: ownerRole,
      })
      .strict(),
    schemaVersion: version,
    tenantId,
    tls: z
      .object({
        ca: z.string().max(32_768).optional(),
        enabled: z.boolean(),
        rejectUnauthorized: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type DatasourceBundle = z.infer<typeof datasourceBundleSchema>;

/** Readiness binds the current datasource without transmitting either password. */
export const datasourceBindingSchema = z
  .object({
    ...datasourceBundleSchema.shape,
    runtimeCredential: z.object({ username: runtimeRole }).strict(),
    schemaOwner: z.object({ role: ownerRole, username: ownerRole }).strict(),
  })
  .strict();
export const datasourceReadinessRequestSchema = z
  .object({
    datasource: datasourceBindingSchema,
    tenantId,
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

/** The root department's per-member budget (Console `memberBudgetSchema`): USD, null never resets. */
export const memberBudgetSchema = z
  .object({
    budgetDuration: z.enum(['1d', '7d', '1mo']).nullable(),
    maxBudget: z.number().min(0).max(100_000_000),
  })
  .strict();

export const provisionRequestSchema = z
  .object({
    datasource: datasourceBundleSchema,
    memberBudget: memberBudgetSchema.optional(),
    name: z.string().trim().min(1).max(256),
    operationId: id,
    rootOperationId: id,
    // Slug rules are checked by the service so a bad slug becomes a recorded
    // `failed` result (FR-CP-04 §4), not a 400 Console would retry forever.
    slug: z.string().min(1).max(63),
    tenantId,
  })
  .strict();
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

export const provisionQuerySchema = z.object({ operationId: id, tenantId }).strict();

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
  .object({ datasource: datasourceBundleSchema, operationId: id, tenantId })
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
    tenantId,
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

export const lifecycleQuerySchema = z.object({ eventId: id, tenantId }).strict();
export const overviewQuerySchema = z.object({ tenantId }).strict();

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

const slugShape = z.string().refine(isWellFormedTenantSlug, 'SLUG_INVALID');

/**
 * Name and slug edited after creation (`tenant-profile`). Version 1 is the provision itself, so a
 * revision starts at 2. `formerSlugs` is the tenant's whole alias set: they keep resolving to it.
 */
export const profileRequestSchema = z
  .object({
    eventId: id,
    formerSlugs: z.array(slugShape),
    name: z.string().trim().min(1).max(256),
    slug: slugShape,
    tenantId,
    version: version.min(2),
  })
  .strict()
  .refine((v) => new Set(v.formerSlugs).size === v.formerSlugs.length, 'DUPLICATE_FORMER_SLUG')
  .refine((v) => !v.formerSlugs.includes(v.slug), 'SLUG_IS_FORMER_SLUG');
export type ProfileRequest = z.output<typeof profileRequestSchema>;

export interface ProfileResult {
  acceptedVersion: number;
  appliedVersion: number;
  errorCode: null;
  eventId: string;
  /** The receiver's name and slug after handling, whatever the request asked. */
  name: string;
  observedAt: string;
  slug: string;
  status: 'applied' | 'superseded';
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
/** tenant-destruction.json: the three phases of one destruction, each repeatable. */
export const DESTRUCTION_PHASES = ['barrier', 'drain', 'unregister'] as const;
export type DestructionPhase = (typeof DESTRUCTION_PHASES)[number];

/** UUID chosen by Console for one destruction of a tenant UUID; compared lower-cased. */
const destroyOperationId = z
  .string()
  .regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
  .transform((value) => value.toLowerCase());

export const destructionRequestSchema = z
  .object({ destroyOperationId, phase: z.enum(DESTRUCTION_PHASES), tenantId })
  .strict();
export type DestructionRequest = z.output<typeof destructionRequestSchema>;

export const destructionQuerySchema = z
  .object({ destroyOperationId: destroyOperationId.optional(), tenantId })
  .strict();

export type DestructionStatus = 'applied' | 'applying' | 'absent';
export type UnregisterItemResult = 'deleted' | 'absent' | 'detached' | 'retained';

export interface DestructionResult {
  completedAt: string | null;
  destroyOperationId: string;
  drainResult: 'drained' | 'fenced' | null;
  items?: { item: string; result: UnregisterItemResult }[];
  phase: DestructionPhase;
  status: DestructionStatus;
  tenantId: string;
  terminalEstablishedAt: string;
}

export interface DestructionStatusResult {
  completedAt: string | null;
  destroyOperationId: string | null;
  drainResult: 'drained' | 'fenced' | null;
  reached: DestructionPhase | null;
  tenantId: string;
  terminalEstablishedAt: string | null;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
    readonly code: SafeErrorCode | 'INVALID_INPUT' | 'NOT_FOUND' | 'REQUEST_TOO_LARGE' | 'INTERNAL',
  ) {
    super(code);
    this.name = 'ControlPlaneError';
  }
}

/** A refusal because the tenant UUID is under destruction: never a failed step, never retried. */
export const isDestroyedRefusal = (error: unknown): error is ControlPlaneError =>
  error instanceof ControlPlaneError && error.code === 'TENANT_DESTROYED';
