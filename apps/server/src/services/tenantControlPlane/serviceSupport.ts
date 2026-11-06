import { createHash } from 'node:crypto';

import type { TenantMemberBudget } from '@lobechat/database/tenant';
import { hashPassword } from 'better-auth/crypto';

import type { BootstrapOwner, DatasourceBundle } from './contracts';
import type { PendingOwner } from './repository';

/** What an operation keeps of a received Owner: the password only as Better Auth's hash. */
export const pendingOwnerOf = async ({
  email,
  name,
  password,
}: BootstrapOwner): Promise<PendingOwner> => ({
  email,
  name,
  passwordHash: await hashPassword(password),
});

/** Stable digest of a request, so a retry with the same input is recognised. */
export const hashInput = (value: unknown): string => {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
};

/** The side effects a lifecycle change needs, in order (FR-CP-06 execution). */
export interface LifecycleHooks {
  /** Close, or force re-validation of, the tenant's SSE / WebSocket connections. */
  closeRealtime: (
    tenantId: string,
    context: { tenantId: string; eventId: string; acceptedVersion: number },
  ) => Promise<void>;
  /** Wait for in-flight business transactions; reject on timeout. */
  drainTransactions: (tenantId: string) => Promise<void>;
  /** Broadcast invalidation of the tenant's admission, authz and config caches. */
  invalidateCaches: (tenantId: string) => Promise<void>;
  /** Resume claiming the tenant's queued jobs. */
  resumeQueue: (tenantId: string) => Promise<void>;
  /** Stop claiming the tenant's queued jobs and wait for running ones. */
  stopQueue: (tenantId: string) => Promise<void>;
}

export interface ProvisionStepContext {
  /** The initial Owner the `seed` step creates; absent when the request carried none. */
  bootstrapOwner?: PendingOwner | null;
  bundle: DatasourceBundle;
  /** Only the provision `seed` step reads it; a lifecycle restore never seeds. */
  memberBudget?: TenantMemberBudget | null;
  name: string;
  operationId: string;
  slug: string;
  tenantId: string;
}

/**
 * Database work of the provision steps (FR-CP-04) and of `tenant-datasource`
 * verification (FR-CP-05), implemented by the Postgres executor. Each method
 * must be idempotent: a failed or interrupted provision resumes at the step
 * that did not finish. A rejection fails the step with that step's code; the
 * rejection itself is never logged or returned, since it may quote a DSN.
 */
export interface TenantDatabaseExecutor {
  /**
   * As the schema owner: the schema exists and is owned by the owner role, the
   * owner has no SUPERUSER / CREATEROLE / CREATEDB / BYPASSRLS, and the schema
   * is empty or has a valid migration history.
   */
  checkOwnership: (ctx: ProvisionStepContext) => Promise<void>;
  /** As the owner, `search_path = tenant, extensions, paradedb`: the tenant migration chain plus owner-only grants. */
  migrate: (ctx: ProvisionStepContext) => Promise<void>;
  /** Copies the default config templates (`runtime_configs`, …) into the tenant. */
  seed: (ctx: ProvisionStepContext) => Promise<void>;
  /** As the owner: the tenant's initial account takes this Owner (`seedBootstrapOwner`). */
  syncBootstrapOwner: (ctx: {
    bundle: DatasourceBundle;
    owner: PendingOwner;
    tenantId: string;
  }) => Promise<void>;
  /**
   * As the runtime user: verifies schema/history and asserts no cross-schema USAGE
   * beyond the extension schemas, no public table access, DML but no CREATE.
   */
  verify: (ctx: { bundle: DatasourceBundle; tenantId: string }) => Promise<void>;
  /** Lookup readiness is certified only at provision, upgrade and actual recovery. */
  verifyDiscovery: (ctx: { bundle: DatasourceBundle; tenantId: string }) => Promise<void>;
  /** Provision only: verifies capture when Elasticsearch is selected, without installing it. */
  verifyProvisionCapture: (ctx: { bundle: DatasourceBundle; tenantId: string }) => Promise<void>;
}
