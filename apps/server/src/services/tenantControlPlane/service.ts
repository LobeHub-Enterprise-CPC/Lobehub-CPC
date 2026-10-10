import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ControlPlaneError,
  type DatasourceBundle,
  type DatasourceRequest,
  type DatasourceResult,
  type FreezeReason,
  type LifecycleRequest,
  type LifecycleResult,
  type ProvisionRequest,
  type ProvisionResult,
  type SafeErrorCode,
  type TenantOverview,
  type TenantState,
} from './contracts';
import { redactDatasourceBundle, validateDatasourceBundle } from './datasource';
import {
  type ControlPlaneRepository,
  type ControlPlaneTx,
  type LifecycleEventRecord,
  PROVISION_STEPS,
  type ProvisionOperationRecord,
  type ProvisionStep,
  type TenantLifecycleRecord,
} from './repository';

/**
 * Receipt and query semantics of the LobeHub control-plane endpoints
 * (spec FR-CP-04..07), plus the lifecycle executor's state machine.
 *
 * Console creates the tenant's schema and roles and sends the credential
 * bundle; LobeHub validates it, then runs its own steps inside that schema.
 * The database work itself sits behind `TenantDatabaseExecutor`; this module
 * decides what Console is told, which transitions are legal and where a
 * resumed provision picks up.
 *
 * Bundles carry passwords: nothing here logs a bundle or puts one in an error.
 */

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

/**
 * offline > frozen > active. Expiry is evaluated against `now` on every call,
 * so a tenant locks at `expiresAt` even if Console's `expired` event is late.
 */
export const effectiveTenantState = (
  lifecycle: Pick<TenantLifecycleRecord, 'desiredState' | 'expiresAt' | 'freezeReasons'>,
  now: Date,
): { reasons: FreezeReason[]; state: TenantState } => {
  const reasons = [...lifecycle.freezeReasons];
  if (
    lifecycle.expiresAt &&
    Date.parse(lifecycle.expiresAt) <= now.getTime() &&
    !reasons.includes('expired')
  )
    reasons.push('expired');
  if (lifecycle.desiredState === 'offline') return { reasons, state: 'offline' };
  if (lifecycle.desiredState === 'frozen' || reasons.length > 0)
    return { reasons, state: 'frozen' };
  return { reasons, state: 'active' };
};

/** The side effects a lifecycle change needs, in order (FR-CP-06 execution). */
export interface LifecycleHooks {
  /** Close, or force re-validation of, the tenant's SSE / WebSocket connections. */
  closeRealtime: (tenantId: string) => Promise<void>;
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
  bundle: DatasourceBundle;
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
   * is empty or already carries this tenant's marker.
   */
  checkOwnership: (ctx: ProvisionStepContext) => Promise<void>;
  /** As the owner, `search_path = tenant, extensions, paradedb`: the tenant migration chain plus owner-only grants. */
  migrate: (ctx: ProvisionStepContext) => Promise<void>;
  /** Copies the default config templates (`runtime_configs`, …) into the tenant. */
  seed: (ctx: ProvisionStepContext) => Promise<void>;
  /**
   * As the runtime user: reads the marker, and asserts no cross-schema USAGE
   * beyond the extension schemas, no public table access, DML but no CREATE.
   */
  verify: (ctx: { bundle: DatasourceBundle; tenantId: string }) => Promise<void>;
  /** Writes `tenant_metadata(tenant_id, 'lobehub', schema_version)`. */
  writeMarker: (ctx: ProvisionStepContext) => Promise<void>;
}

/** The code a failed step reports (FR-CP-04 step table). */
const STEP_ERROR: Record<ProvisionStep, SafeErrorCode> = {
  directory: 'CREDENTIALS_UNAVAILABLE',
  marker: 'TENANT_PROVISION_FAILED',
  migrate: 'TENANT_PROVISION_FAILED',
  ownership: 'DATASOURCE_INVALID',
  seed: 'TENANT_PROVISION_FAILED',
  validate: 'DATASOURCE_INVALID',
  verify: 'DATASOURCE_INVALID',
};

/** Digest over the whole bundle, passwords included; only ever compared, never stored. */
const bundleDigest = (bundle: DatasourceBundle) => Buffer.from(hashInput(bundle), 'hex');

const sameBundle = (a: DatasourceBundle, b: DatasourceBundle) =>
  timingSafeEqual(bundleDigest(a), bundleDigest(b));

export interface TenantControlPlaneServiceOptions {
  /** Database side of provisioning and rotation. */
  database: TenantDatabaseExecutor;
  isRegistrableSlug: (slug: string) => boolean;
  now?: () => Date;
  repository: ControlPlaneRepository;
}

const toProvisionResult = (op: ProvisionOperationRecord): ProvisionResult => ({
  credentialBundleVersion: op.credentialBundleVersion,
  datasourceReady: op.datasourceReady,
  errorCode: op.errorCode,
  operationId: op.operationId,
  schemaName: op.schemaName,
  schemaVersion: op.schemaVersion,
  status: op.status,
  tenantId: op.tenantId,
});

/**
 * A tenant becomes known on its first provision request. Until Console sends
 * an `active` event it stays `offline`, so a freshly provisioned schema never
 * opens for business on its own (FR-CP-04 §7).
 */
const initialLifecycle = (tenantId: string): TenantLifecycleRecord => ({
  acceptedVersion: 0,
  appliedVersion: 0,
  desiredState: 'offline',
  expiresAt: null,
  freezeReasons: [],
  tenantId,
});

export class TenantControlPlaneService {
  private readonly repository: ControlPlaneRepository;
  private readonly now: () => Date;

  constructor(private readonly options: TenantControlPlaneServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
  }

  // ─── provision ───────────────────────────────────────────────────────────

  /** The `validate` step: pure checks, run before anything is stored or touched. */
  private validate(request: ProvisionRequest): SafeErrorCode | null {
    if (!this.options.isRegistrableSlug(request.slug)) return 'TENANT_INVALID';
    return validateDatasourceBundle(request.tenantId, request.datasource);
  }

  async receiveProvision(request: ProvisionRequest): Promise<ProvisionResult> {
    // Passwords are left out: a password change alone is a rotation
    // (tenant-datasource), not a different provision request.
    const inputHash = hashInput({
      ...request,
      datasource: redactDatasourceBundle(request.datasource),
    });

    return this.repository.transaction(request.tenantId, async (tx) => {
      const existing = await tx.getOperation(request.operationId);
      if (existing) {
        if (existing.tenantId !== request.tenantId)
          throw new ControlPlaneError(409, 'TENANT_INVALID');
        if (existing.inputHash !== inputHash) throw new ControlPlaneError(409, 'VERSION_CONFLICT');
        // Console re-posts a failed operation under its original id to retry it.
        if (existing.status === 'failed') {
          if (existing.step === 'validate') {
            // Validation depends on deployment state too (registrable slugs,
            // supported schema versions), so a retry re-runs it rather than
            // repeating the old verdict.
            const code = this.validate(request);
            if (code) {
              existing.errorCode = code;
              await tx.putOperation(existing);
              return toProvisionResult(existing);
            }
            existing.step = 'ownership';
          }
          existing.status = 'received';
          existing.errorCode = null;
          await tx.putOperation(existing);
          // Same digest, so same bundle versions; keep the latest secrets.
          await tx.putOperationBundle(existing.operationId, request.datasource);
        }
        return toProvisionResult(existing);
      }

      const siblings = await tx.listOperations(request.tenantId);
      if (siblings.some((op) => op.status === 'applied' || op.slug !== request.slug))
        throw new ControlPlaneError(409, 'TENANT_INVALID');
      const slugOwner = await tx.findTenantBySlug(request.slug);
      if (slugOwner && slugOwner !== request.tenantId)
        throw new ControlPlaneError(409, 'TENANT_INVALID');

      const code = this.validate(request);
      const record: ProvisionOperationRecord = {
        attempts: 0,
        credentialBundleVersion: null,
        datasourceReady: false,
        errorCode: code,
        inputHash,
        name: request.name,
        operationId: request.operationId,
        schemaName: null,
        schemaVersion: null,
        slug: request.slug,
        status: code ? 'failed' : 'received',
        step: code ? 'validate' : 'ownership',
        tenantId: request.tenantId,
      };
      await tx.putOperation(record);
      // An invalid bundle is not kept: nothing will ever run with it.
      if (!code) await tx.putOperationBundle(record.operationId, request.datasource);
      if (!(await tx.getLifecycle(request.tenantId)))
        await tx.putLifecycle(initialLifecycle(request.tenantId));
      return toProvisionResult(record);
    });
  }

  async getProvision(tenantId: string, operationId: string): Promise<ProvisionResult> {
    const op = await this.repository.transaction(tenantId, (tx) => tx.getOperation(operationId));
    if (!op || op.tenantId !== tenantId) throw new ControlPlaneError(404, 'NOT_FOUND');
    return toProvisionResult(op);
  }

  /**
   * Runs a received operation's remaining steps, from the one recorded on the
   * operation, persisting progress after each so a crash or failure resumes
   * there. `applied` only after `verify`: the directory is registered and the
   * runtime user has read the marker (FR-CP-04 §6).
   */
  async executeProvision(tenantId: string, operationId: string): Promise<ProvisionResult> {
    const claimed = await this.repository.transaction(tenantId, async (tx) => {
      const op = await tx.getOperation(operationId);
      if (!op || op.tenantId !== tenantId) throw new ControlPlaneError(404, 'NOT_FOUND');
      if (op.status === 'applied' || op.status === 'failed') return { op, run: false as const };
      const bundle = await tx.getOperationBundle(operationId);
      if (!bundle) {
        await this.finishOperation(tx, op, 'CREDENTIALS_UNAVAILABLE');
        return { op, run: false as const };
      }
      op.status = 'applying';
      op.attempts += 1;
      await tx.putOperation(op);
      return { bundle, op, run: true as const };
    });
    if (!claimed.run) return toProvisionResult(claimed.op);

    const { bundle, op } = claimed;
    const ctx: ProvisionStepContext = {
      bundle,
      name: op.name,
      operationId,
      slug: op.slug,
      tenantId,
    };
    const remaining = PROVISION_STEPS.slice(PROVISION_STEPS.indexOf(op.step));

    for (const [index, step] of remaining.entries()) {
      try {
        await this.runProvisionStep(step, ctx);
      } catch {
        return this.repository.transaction(tenantId, async (tx) => {
          const current = (await tx.getOperation(operationId))!;
          current.step = step;
          await this.finishOperation(tx, current, STEP_ERROR[step]);
          return toProvisionResult(current);
        });
      }
      const next = remaining[index + 1];
      if (next)
        await this.repository.transaction(tenantId, async (tx) => {
          const current = (await tx.getOperation(operationId))!;
          current.step = next;
          await tx.putOperation(current);
        });
    }

    return this.repository.transaction(tenantId, async (tx) => {
      const current = (await tx.getOperation(operationId))!;
      Object.assign(current, {
        credentialBundleVersion: bundle.credentialBundleVersion,
        datasourceReady: true,
        errorCode: null,
        schemaName: bundle.schemaName,
        schemaVersion: bundle.schemaVersion,
        status: 'applied',
      } satisfies Partial<ProvisionOperationRecord>);
      await tx.putOperation(current);
      // The directory now holds the bundle; drop the operation's copy.
      await tx.putOperationBundle(operationId, null);
      return toProvisionResult(current);
    });
  }

  private async runProvisionStep(step: ProvisionStep, ctx: ProvisionStepContext) {
    const db = this.options.database;
    switch (step) {
      case 'validate': {
        if (validateDatasourceBundle(ctx.tenantId, ctx.bundle))
          throw new Error('invalid datasource');
        return;
      }
      case 'ownership': {
        return db.checkOwnership(ctx);
      }
      case 'migrate': {
        return db.migrate(ctx);
      }
      case 'marker': {
        return db.writeMarker(ctx);
      }
      case 'seed': {
        return db.seed(ctx);
      }
      case 'directory': {
        return this.repository.transaction(ctx.tenantId, async (tx) => {
          const current = await tx.getDirectory(ctx.tenantId);
          // A newer bundle already registered (rotation) is never rolled back.
          if (
            current &&
            current.record.credentialBundleVersion > ctx.bundle.credentialBundleVersion
          )
            return;
          await tx.putDirectory(
            {
              connectionVersion: ctx.bundle.connectionVersion,
              credentialBundleVersion: ctx.bundle.credentialBundleVersion,
              name: ctx.name,
              schemaName: ctx.bundle.schemaName,
              schemaVersion: ctx.bundle.schemaVersion,
              slug: ctx.slug,
              status: 'active',
              tenantId: ctx.tenantId,
            },
            ctx.bundle,
          );
        });
      }
      case 'verify': {
        return db.verify({ bundle: ctx.bundle, tenantId: ctx.tenantId });
      }
    }
  }

  private async finishOperation(
    tx: ControlPlaneTx,
    op: ProvisionOperationRecord,
    errorCode: SafeErrorCode,
  ) {
    op.status = 'failed';
    op.errorCode = errorCode;
    await tx.putOperation(op);
  }

  // ─── datasource rotation ─────────────────────────────────────────────────

  /**
   * Applies a rotated or moved bundle (FR-CP-05): validated like a provision,
   * verified with the new credentials, then swapped into the directory in one
   * transaction. Synchronous; `failed` answers 503 so Console retries.
   */
  async receiveDatasource(request: DatasourceRequest): Promise<DatasourceResult> {
    const { datasource, operationId, tenantId } = request;
    const result = (
      status: DatasourceResult['status'],
      errorCode: SafeErrorCode | null,
    ): DatasourceResult => ({
      connectionVersion: datasource.connectionVersion,
      credentialBundleVersion: datasource.credentialBundleVersion,
      datasourceKind: 'lobehub',
      errorCode,
      operationId,
      status,
      tenantId,
    });

    /** 'same' for an idempotent retry, otherwise the record to replace. */
    const compare = async (tx: ControlPlaneTx) => {
      const current = await tx.getDirectory(tenantId);
      if (!current) throw new ControlPlaneError(404, 'TENANT_NOT_FOUND');
      const { bundle, record } = current;
      if (datasource.credentialBundleVersion < record.credentialBundleVersion)
        throw new ControlPlaneError(409, 'DATASOURCE_VERSION_CONFLICT');
      if (datasource.credentialBundleVersion === record.credentialBundleVersion) {
        if (sameBundle(bundle, datasource)) return 'same' as const;
        throw new ControlPlaneError(409, 'DATASOURCE_VERSION_CONFLICT');
      }
      if (datasource.connectionVersion < record.connectionVersion)
        throw new ControlPlaneError(409, 'DATASOURCE_VERSION_CONFLICT');
      return record;
    };

    const first = await this.repository.transaction(tenantId, async (tx) => {
      if (!(await tx.getDirectory(tenantId))) throw new ControlPlaneError(404, 'TENANT_NOT_FOUND');
      if (validateDatasourceBundle(tenantId, datasource)) return 'invalid' as const;
      return compare(tx);
    });
    if (first === 'invalid') return result('failed', 'DATASOURCE_INVALID');
    if (first === 'same') return result('applied', null);

    try {
      await this.options.database.verify({ bundle: datasource, tenantId });
    } catch {
      return result('failed', 'DATASOURCE_INVALID');
    }

    return this.repository.transaction(tenantId, async (tx) => {
      // Re-checked: another rotation may have committed while we verified.
      const record = await compare(tx);
      if (record === 'same') return result('applied', null);
      await tx.putDirectory(
        {
          ...record,
          connectionVersion: datasource.connectionVersion,
          credentialBundleVersion: datasource.credentialBundleVersion,
        },
        datasource,
      );
      return result('applied', null);
    });
  }

  // ─── lifecycle receipt ───────────────────────────────────────────────────

  async receiveLifecycle(request: LifecycleRequest): Promise<LifecycleResult> {
    const payloadHash = hashInput(request);

    return this.repository.transaction(request.tenantId, async (tx) => {
      const lifecycle = await tx.getLifecycle(request.tenantId);
      if (!lifecycle) throw new ControlPlaneError(404, 'TENANT_NOT_FOUND');

      const existing = await tx.getEvent(request.eventId);
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.tenantId !== request.tenantId)
          throw new ControlPlaneError(409, 'VERSION_CONFLICT');
        // Console re-posts a failed event to retry it; the executor picks it up again.
        if (existing.status === 'failed' && existing.version === lifecycle.acceptedVersion) {
          existing.status = 'received';
          existing.errorCode = null;
          existing.observedAt = this.now().toISOString();
          await tx.putEvent(existing);
        }
        return this.toLifecycleResult(existing, lifecycle);
      }

      const taken = await tx.findEventByVersion(request.tenantId, request.version);
      if (taken) throw new ControlPlaneError(409, 'VERSION_CONFLICT');

      const observedAt = this.now().toISOString();
      const event: LifecycleEventRecord = {
        attempts: 0,
        errorCode: null,
        eventId: request.eventId,
        observedAt,
        payloadHash,
        request,
        status: request.version <= lifecycle.acceptedVersion ? 'superseded' : 'received',
        tenantId: request.tenantId,
        version: request.version,
      };

      if (event.status === 'received') {
        // Older events still in flight can no longer win; mark them now so a
        // late executor cannot reopen what this event closes.
        for (const open of await tx.listOpenEvents(request.tenantId)) {
          open.status = 'superseded';
          open.errorCode = null;
          open.observedAt = observedAt;
          await tx.putEvent(open);
        }
        // Accepting and taking effect at the gate are one step: from this
        // commit on, admission sees the new desired state (FR-ID-07).
        lifecycle.acceptedVersion = request.version;
        lifecycle.desiredState = request.desiredState;
        lifecycle.freezeReasons = [...request.freezeReasons];
        lifecycle.expiresAt = request.expiresAt;
        await tx.putLifecycle(lifecycle);
      }

      await tx.putEvent(event);
      return this.toLifecycleResult(event, lifecycle);
    });
  }

  async getLifecycle(tenantId: string, eventId: string): Promise<LifecycleResult> {
    return this.repository.transaction(tenantId, async (tx) => {
      const event = await tx.getEvent(eventId);
      const lifecycle = await tx.getLifecycle(tenantId);
      if (!event || !lifecycle || event.tenantId !== tenantId)
        throw new ControlPlaneError(404, 'NOT_FOUND');
      return this.toLifecycleResult(event, lifecycle);
    });
  }

  async getOverview(tenantId: string): Promise<TenantOverview> {
    return this.repository.transaction(tenantId, async (tx) => {
      const lifecycle = await tx.getLifecycle(tenantId);
      const operations = await tx.listOperations(tenantId);
      if (!lifecycle || operations.length === 0)
        throw new ControlPlaneError(404, 'TENANT_NOT_FOUND');

      const now = this.now();
      const { reasons, state } = effectiveTenantState(lifecycle, now);
      return {
        acceptedVersion: lifecycle.acceptedVersion,
        appliedVersion: lifecycle.appliedVersion,
        desiredState: lifecycle.desiredState,
        effectiveState: state,
        expiresAt: lifecycle.expiresAt,
        freezeReasons: reasons,
        observedAt: now.toISOString(),
        readiness: operations.some((op) => op.status === 'applied')
          ? 'ready'
          : operations.some((op) => op.status === 'applying')
            ? 'applying'
            : operations.every((op) => op.status === 'failed')
              ? 'failed'
              : 'pending',
        slug: operations[0].slug,
        tenantId,
      };
    });
  }

  // ─── lifecycle execution ─────────────────────────────────────────────────

  /**
   * Drives one received event to `applied`, `failed` or `superseded`.
   * Before every phase it re-checks that the event is still the tenant's
   * accepted version, so a slow executor for an old event stops instead of
   * overwriting a newer state.
   */
  async executeLifecycle(
    tenantId: string,
    eventId: string,
    hooks: LifecycleHooks,
  ): Promise<LifecycleResult> {
    const claimed = await this.repository.transaction(tenantId, async (tx) => {
      const event = await tx.getEvent(eventId);
      const lifecycle = await tx.getLifecycle(tenantId);
      if (!event || !lifecycle || event.tenantId !== tenantId)
        throw new ControlPlaneError(404, 'NOT_FOUND');
      if (event.status === 'applied' || event.status === 'superseded')
        return { event, lifecycle, run: false };
      if (event.version !== lifecycle.acceptedVersion) {
        await this.finishEvent(tx, event, 'superseded', null);
        return { event, lifecycle, run: false };
      }
      if (event.request.desiredState === 'active') {
        const ready = (await tx.listOperations(tenantId)).some((op) => op.status === 'applied');
        if (!ready) {
          await this.finishEvent(tx, event, 'failed', 'TENANT_NOT_READY');
          return { event, lifecycle, run: false };
        }
      }
      event.status = 'applying';
      event.attempts += 1;
      event.errorCode = null;
      event.observedAt = this.now().toISOString();
      await tx.putEvent(event);
      return { event, lifecycle, run: true };
    });
    if (!claimed.run) return this.toLifecycleResult(claimed.event, claimed.lifecycle);

    const closing = effectiveTenantState(claimed.event.request, this.now()).state !== 'active';
    const phases: ((id: string) => Promise<void>)[] = closing
      ? [hooks.invalidateCaches, hooks.closeRealtime, hooks.stopQueue, hooks.drainTransactions]
      : [hooks.invalidateCaches, hooks.resumeQueue];

    for (const phase of phases) {
      const stale = await this.supersedeIfStale(tenantId, eventId);
      if (stale) return stale;
      try {
        await phase(tenantId);
      } catch {
        // The gate already refuses the tenant; failing here only means the
        // drain is unfinished. Console or the executor retries the event.
        return this.repository.transaction(tenantId, async (tx) => {
          const event = (await tx.getEvent(eventId))!;
          const lifecycle = (await tx.getLifecycle(tenantId))!;
          if (event.version !== lifecycle.acceptedVersion)
            await this.finishEvent(tx, event, 'superseded', null);
          else await this.finishEvent(tx, event, 'failed', 'LIFECYCLE_FAILED');
          return this.toLifecycleResult(event, lifecycle);
        });
      }
    }

    return this.repository.transaction(tenantId, async (tx) => {
      const event = (await tx.getEvent(eventId))!;
      const lifecycle = (await tx.getLifecycle(tenantId))!;
      if (event.version !== lifecycle.acceptedVersion || event.status !== 'applying') {
        if (event.status === 'applying') await this.finishEvent(tx, event, 'superseded', null);
        return this.toLifecycleResult(event, lifecycle);
      }
      if (closing && !(await tx.isTenantStopped(tenantId))) {
        await this.finishEvent(tx, event, 'failed', 'LIFECYCLE_FAILED');
        return this.toLifecycleResult(event, lifecycle);
      }
      lifecycle.appliedVersion = Math.max(lifecycle.appliedVersion, event.version);
      await tx.putLifecycle(lifecycle);
      await this.finishEvent(tx, event, 'applied', null);
      return this.toLifecycleResult(event, lifecycle);
    });
  }

  private async supersedeIfStale(tenantId: string, eventId: string) {
    return this.repository.transaction(tenantId, async (tx) => {
      const event = (await tx.getEvent(eventId))!;
      const lifecycle = (await tx.getLifecycle(tenantId))!;
      if (event.status === 'applying' && event.version === lifecycle.acceptedVersion) return null;
      if (event.status === 'applying') await this.finishEvent(tx, event, 'superseded', null);
      return this.toLifecycleResult(event, lifecycle);
    });
  }

  private async finishEvent(
    tx: ControlPlaneTx,
    event: LifecycleEventRecord,
    status: 'applied' | 'failed' | 'superseded',
    errorCode: SafeErrorCode | null,
  ) {
    event.status = status;
    event.errorCode = errorCode;
    event.observedAt = this.now().toISOString();
    await tx.putEvent(event);
  }

  /**
   * Shapes a result that satisfies every invariant Console checks
   * (`RESPONSE_MISMATCH` otherwise): accepted ≥ version, applied ≤ accepted,
   * superseded ⇒ accepted > version, applied ⇒ appliedVersion ≥ version.
   */
  private toLifecycleResult(
    event: LifecycleEventRecord,
    lifecycle: TenantLifecycleRecord,
  ): LifecycleResult {
    return {
      acceptedVersion: lifecycle.acceptedVersion,
      appliedVersion: lifecycle.appliedVersion,
      errorCode: event.errorCode,
      eventId: event.eventId,
      observedAt: event.observedAt,
      status: event.status,
      tenantId: event.tenantId,
      version: event.version,
    };
  }
}
