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
] as const;
export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

export const CONTROL_PLANE_ACTIONS = [
  'tenant.provision',
  'tenant.provision_read',
  'tenant.datasource.apply',
  'tenant.lifecycle.apply',
  'tenant.lifecycle.read',
  'tenant.overview.read',
] as const;
export type ControlPlaneAction = (typeof CONTROL_PLANE_ACTIONS)[number];

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
