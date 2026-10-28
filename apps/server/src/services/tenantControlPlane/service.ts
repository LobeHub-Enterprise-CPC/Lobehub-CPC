import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  isSafeReadinessDiagnosticCode,
  readinessDiagnosticOf,
  type SafeReadinessDiagnosticCode,
  TenantReadinessError,
} from '@lobechat/database/tenant';

import { effectiveTenantState } from '@/server/modules/Tenant/lifecycleState';

import {
  ControlPlaneError,
  type DatasourceBundle,
  type DatasourceReadinessRequest,
  type DatasourceReadinessResult,
  type DatasourceRequest,
  type DatasourceResult,
  isDestroyedRefusal,
  LifecycleFailure,
  type LifecycleFailureCode,
  type LifecycleRequest,
  type LifecycleResult,
  type ProvisionRequest,
  type ProvisionResult,
  type SafeErrorCode,
  type TenantOverview,
} from './contracts';
import { redactDatasourceBundle, validateDatasourceBundle } from './datasource';
import { type TenantDestructionOptions, TenantDestructionService } from './destruction';
import {
  type ControlPlaneRepository,
  type ControlPlaneTx,
  type LifecycleEventRecord,
  PROVISION_STEPS,
  type ProvisionOperationRecord,
  type ProvisionStep,
  type TenantLifecycleRecord,
} from './repository';
import {
  hashInput,
  type LifecycleHooks,
  type ProvisionStepContext,
  type TenantDatabaseExecutor,
} from './serviceSupport';

export { effectiveTenantState } from '@/server/modules/Tenant/lifecycleState';

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

export type {
  LifecycleHooks,
  ProvisionStepContext,
  TenantDatabaseExecutor,
} from './serviceSupport';
export { hashInput } from './serviceSupport';

/** The code a failed step reports (FR-CP-04 step table). */
const STEP_ERROR: Record<ProvisionStep, SafeErrorCode> = {
  directory: 'CREDENTIALS_UNAVAILABLE',
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
  /** Clock, pool and wait settings of the destruction phases. */
  destruction?: Omit<TenantDestructionOptions, 'now' | 'repository'>;
  isRegistrableSlug: (slug: string) => boolean;
  now?: () => Date;
  repository: ControlPlaneRepository;
}

const toProvisionResult = (op: ProvisionOperationRecord): ProvisionResult => ({
  credentialBundleVersion: op.credentialBundleVersion,
  datasourceReady: op.datasourceReady,
  diagnosticCode: isSafeReadinessDiagnosticCode(op.diagnosticCode) ? op.diagnosticCode : null,
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
  /** barrier / drain / unregister and status of a tenant UUID's destruction. */
  readonly destruction: TenantDestructionService;

  private leaseUntil = () => new Date(this.now().getTime() + 5 * 60_000).toISOString();

  constructor(private readonly options: TenantControlPlaneServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.destruction = new TenantDestructionService({
      ...options.destruction,
      now: this.now,
      repository: this.repository,
    });
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
              existing.diagnosticCode =
                code === 'DATASOURCE_INVALID' ? 'DATASOURCE_BINDING_INVALID' : null;
              if (code === 'DATASOURCE_INVALID')
                this.logReadinessFailure(
                  request.tenantId,
                  request.operationId,
                  'validate',
                  code,
                  new TenantReadinessError('DATASOURCE_BINDING_INVALID'),
                );
              await tx.putOperation(existing);
              return toProvisionResult(existing);
            }
            existing.step = 'ownership';
          }
          existing.status = 'received';
          existing.errorCode = null;
          existing.diagnosticCode = null;
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
        diagnosticCode: code === 'DATASOURCE_INVALID' ? 'DATASOURCE_BINDING_INVALID' : null,
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
      if (code === 'DATASOURCE_INVALID')
        this.logReadinessFailure(
          request.tenantId,
          request.operationId,
          'validate',
          code,
          new TenantReadinessError('DATASOURCE_BINDING_INVALID'),
        );
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
   * runtime connection has passed schema, history and privilege verification.
   */
  async executeProvision(tenantId: string, operationId: string): Promise<ProvisionResult> {
    const claimed = await this.repository.transaction(tenantId, async (tx) => {
      const op = await tx.getOperation(operationId);
      if (!op || op.tenantId !== tenantId) throw new ControlPlaneError(404, 'NOT_FOUND');
      if (op.status === 'applied' || op.status === 'failed') return { op, run: false as const };
      if (
        op.status === 'applying' &&
        op.leaseUntil &&
        Date.parse(op.leaseUntil) > this.now().getTime()
      )
        return { op, run: false as const };
      const bundle = await tx.getOperationBundle(operationId);
      if (!bundle) {
        await this.finishOperation(tx, op, 'CREDENTIALS_UNAVAILABLE');
        return { op, run: false as const };
      }
      op.status = 'applying';
      op.diagnosticCode = null;
      op.attempts += 1;
      op.leaseToken = randomUUID();
      op.leaseUntil = this.leaseUntil();
      await tx.putOperation(op);
      return { bundle, op, run: true as const };
    });
    if (!claimed.run) return toProvisionResult(claimed.op);

    const { bundle, op } = claimed;
    const token = op.leaseToken!;
    const owns = (current: ProvisionOperationRecord) =>
      current.status === 'applying' && current.leaseToken === token;
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
        await this.runProvisionStep(step, ctx, token);
      } catch (error) {
        if (isDestroyedRefusal(error)) throw error;
        const diagnosticCode = this.logReadinessFailure(
          tenantId,
          operationId,
          step,
          STEP_ERROR[step],
          error,
        );
        return this.repository.transaction(tenantId, async (tx) => {
          const current = (await tx.getOperation(operationId))!;
          if (!owns(current)) return toProvisionResult(current);
          current.step = step;
          await this.finishOperation(tx, current, STEP_ERROR[step], diagnosticCode);
          return toProvisionResult(current);
        });
      }
      const next = remaining[index + 1];
      if (next) {
        const progress = await this.repository.transaction(tenantId, async (tx) => {
          const current = (await tx.getOperation(operationId))!;
          if (!owns(current)) return toProvisionResult(current);
          current.step = next;
          current.leaseUntil = this.leaseUntil();
          await tx.putOperation(current);
          return null;
        });
        if (progress) return progress;
      }
    }

    return this.repository.transaction(tenantId, async (tx) => {
      const current = (await tx.getOperation(operationId))!;
      if (!owns(current)) return toProvisionResult(current);
      Object.assign(current, {
        credentialBundleVersion: bundle.credentialBundleVersion,
        datasourceReady: true,
        diagnosticCode: null,
        errorCode: null,
        schemaName: bundle.schemaName,
        schemaVersion: bundle.schemaVersion,
        status: 'applied',
        leaseToken: null,
        leaseUntil: null,
      } satisfies Partial<ProvisionOperationRecord>);
      await tx.putOperation(current);
      // The directory now holds the bundle; drop the operation's copy.
      await tx.putOperationBundle(operationId, null);
      return toProvisionResult(current);
    });
  }

  private async runProvisionStep(
    step: ProvisionStep,
    ctx: ProvisionStepContext,
    leaseToken: string,
  ) {
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
      case 'seed': {
        return db.seed(ctx);
      }
      case 'directory': {
        return this.repository.transaction(ctx.tenantId, async (tx) => {
          const operation = await tx.getOperation(ctx.operationId);
          if (operation?.leaseToken !== leaseToken || operation.status !== 'applying')
            throw new Error('PROVISION_LEASE_LOST');
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
              status: 'provisioning',
              tenantId: ctx.tenantId,
            },
            ctx.bundle,
          );
        });
      }
      case 'verify': {
        await db.verify({ bundle: ctx.bundle, tenantId: ctx.tenantId });
        await db.verifyDiscovery({ bundle: ctx.bundle, tenantId: ctx.tenantId });
        return this.repository.transaction(ctx.tenantId, async (tx) => {
          const operation = await tx.getOperation(ctx.operationId);
          if (operation?.leaseToken !== leaseToken || operation.status !== 'applying')
            throw new Error('PROVISION_LEASE_LOST');
          const directory = await tx.getDirectory(ctx.tenantId);
          if (!directory) throw new Error('DIRECTORY_NOT_READY');
          if (directory.record.credentialBundleVersion !== ctx.bundle.credentialBundleVersion)
            throw new Error('PROVISION_VERSION_CHANGED');
          await tx.putDirectory({ ...directory.record, status: 'active' }, directory.bundle);
        });
      }
    }
  }

  private async finishOperation(
    tx: ControlPlaneTx,
    op: ProvisionOperationRecord,
    errorCode: SafeErrorCode,
    diagnosticCode: SafeReadinessDiagnosticCode | null = null,
  ) {
    op.diagnosticCode = diagnosticCode;
    op.status = 'failed';
    op.errorCode = errorCode;
    op.leaseToken = null;
    op.leaseUntil = null;
    await tx.putOperation(op);
  }

  private logReadinessFailure(
    tenantId: string,
    operationId: string | null,
    step: string,
    errorCode: SafeErrorCode,
    error: unknown,
  ) {
    const diagnosticCode = readinessDiagnosticOf(error);
    console.warn(
      JSON.stringify({
        event: 'tenant_readiness_failed',
        tenantId,
        operationId,
        step,
        errorCode,
        diagnosticCode,
      }),
    );
    return diagnosticCode;
  }

  /** Current database evidence, independent of Console/Admin operation identifiers. */
  async getDatasourceReadiness({
    tenantId,
    datasource,
  }: DatasourceReadinessRequest): Promise<DatasourceReadinessResult> {
    const bindingHash = hashInput(datasource);
    const load = () =>
      this.repository.transaction(tenantId, async (tx) => ({
        directory: await tx.getDirectory(tenantId),
        provisioned: (await tx.listOperations(tenantId)).some((op) => op.status === 'applied'),
      }));
    let errorCode: SafeErrorCode | null = null;
    let diagnosticCode: SafeReadinessDiagnosticCode | null = null;
    try {
      const { directory, provisioned } = await load();
      if (!directory || !provisioned) errorCode = 'TENANT_NOT_READY';
      else if (bindingHash !== hashInput(redactDatasourceBundle(directory.bundle))) {
        errorCode = 'DATASOURCE_INVALID';
        diagnosticCode = 'DATASOURCE_BINDING_INVALID';
      } else {
        await this.options.database.verify({ tenantId, bundle: directory.bundle });
        // Rotation during verification invalidates the result for the previous connection.
        const current = await load();
        if (
          !current.provisioned ||
          !current.directory ||
          bindingHash !== hashInput(redactDatasourceBundle(current.directory.bundle))
        ) {
          errorCode = 'DATASOURCE_INVALID';
          diagnosticCode = 'DATASOURCE_BINDING_INVALID';
        }
      }
    } catch (error) {
      if (isDestroyedRefusal(error)) throw error;
      errorCode = 'DATASOURCE_INVALID';
      diagnosticCode = this.logReadinessFailure(tenantId, null, 'readiness', errorCode, error);
    }
    if (errorCode === 'DATASOURCE_INVALID' && diagnosticCode === 'DATASOURCE_BINDING_INVALID')
      this.logReadinessFailure(
        tenantId,
        null,
        'readiness',
        errorCode,
        new TenantReadinessError(diagnosticCode),
      );
    return {
      checkedAt: this.now().toISOString(),
      connectionVersion: datasource.connectionVersion,
      credentialBundleVersion: datasource.credentialBundleVersion,
      datasourceReady: errorCode === null,
      diagnosticCode,
      errorCode,
      schemaName: datasource.schemaName,
      schemaVersion: datasource.schemaVersion,
      tenantId,
    };
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
      diagnosticCode: SafeReadinessDiagnosticCode | null = null,
    ): DatasourceResult => ({
      connectionVersion: datasource.connectionVersion,
      credentialBundleVersion: datasource.credentialBundleVersion,
      datasourceKind: 'lobehub',
      diagnosticCode,
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
    if (first === 'invalid') {
      const diagnostic = this.logReadinessFailure(
        tenantId,
        operationId,
        'datasource',
        'DATASOURCE_INVALID',
        new TenantReadinessError('DATASOURCE_BINDING_INVALID'),
      );
      return result('failed', 'DATASOURCE_INVALID', diagnostic);
    }
    if (first === 'same') return result('applied', null);

    try {
      await this.options.database.verify({ bundle: datasource, tenantId });
    } catch (error) {
      return result(
        'failed',
        'DATASOURCE_INVALID',
        this.logReadinessFailure(tenantId, operationId, 'datasource', 'DATASOURCE_INVALID', error),
      );
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
          throw new ControlPlaneError(409, 'LIFECYCLE_EVENT_CONFLICT');
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
      if (taken) throw new ControlPlaneError(409, 'LIFECYCLE_VERSION_CONFLICT');

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
        // Receipt stays free of owner IO. Only a real recovery closes directory readiness
        // until execution repairs grants; initial activation and active renewals do not migrate.
        if (
          lifecycle.acceptedVersion > 0 &&
          effectiveTenantState(lifecycle, this.now()).state !== 'active' &&
          effectiveTenantState(request, this.now()).state === 'active'
        ) {
          const directory = await tx.getDirectory(request.tenantId);
          if (directory?.record.status === 'active')
            await tx.putDirectory(
              { ...directory.record, status: 'provisioning' },
              directory.bundle,
            );
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
        return { event, lifecycle, run: false, recovery: null };
      if (event.version !== lifecycle.acceptedVersion) {
        await this.finishEvent(tx, event, 'superseded', null);
        return { event, lifecycle, run: false, recovery: null };
      }
      if (
        event.status === 'applying' &&
        event.leaseUntil &&
        Date.parse(event.leaseUntil) > this.now().getTime()
      )
        return { event, lifecycle, run: false, recovery: null };
      let recovery: Awaited<ReturnType<ControlPlaneTx['getDirectory']>> = null;
      if (event.request.desiredState === 'active') {
        const ready = (await tx.listOperations(tenantId)).some((op) => op.status === 'applied');
        const directory = await tx.getDirectory(tenantId);
        if (!ready || !directory) {
          await this.finishEvent(tx, event, 'failed', 'TENANT_NOT_READY');
          return { event, lifecycle, run: false, recovery: null };
        }
        if (
          directory.record.status === 'provisioning' &&
          effectiveTenantState(event.request, this.now()).state === 'active'
        )
          recovery = directory;
      }
      event.status = 'applying';
      event.attempts += 1;
      event.leaseToken = randomUUID();
      event.leaseUntil = this.leaseUntil();
      event.errorCode = null;
      event.observedAt = this.now().toISOString();
      await tx.putEvent(event);
      return { event, lifecycle, run: true, recovery };
    });
    if (!claimed.run) return this.toLifecycleResult(claimed.event, claimed.lifecycle);
    const token = claimed.event.leaseToken!;

    const closing = effectiveTenantState(claimed.event.request, this.now()).state !== 'active';
    // Each phase names the code its failure is recorded with, unless it reports its own reason.
    const phases: [(id: string) => Promise<void>, LifecycleFailureCode][] = closing
      ? [
          [hooks.invalidateCaches, 'LIFECYCLE_FAILED'],
          [
            (id) =>
              hooks.closeRealtime(id, {
                tenantId: id,
                eventId: claimed.event.eventId,
                acceptedVersion: claimed.event.version,
              }),
            'LIFECYCLE_STOP_FAILED',
          ],
          [hooks.stopQueue, 'LIFECYCLE_STOP_FAILED'],
          [hooks.drainTransactions, 'LIFECYCLE_DRAIN_FAILED'],
        ]
      : [
          [hooks.invalidateCaches, 'LIFECYCLE_FAILED'],
          [hooks.resumeQueue, 'LIFECYCLE_RESUME_FAILED'],
        ];

    if (!closing && claimed.recovery) {
      const recovery = claimed.recovery;
      phases.unshift([
        async () => {
          const ctx: ProvisionStepContext = {
            bundle: recovery.bundle,
            name: recovery.record.name,
            slug: recovery.record.slug,
            operationId: `restore:${eventId}`,
            tenantId,
          };
          await this.options.database.migrate(ctx);
          await this.options.database.verify({ bundle: ctx.bundle, tenantId });
          await this.options.database.verifyDiscovery({ bundle: ctx.bundle, tenantId });
          await this.repository.transaction(tenantId, async (tx) => {
            const event = await tx.getEvent(eventId);
            const lifecycle = await tx.getLifecycle(tenantId);
            const directory = await tx.getDirectory(tenantId);
            if (
              !event ||
              !lifecycle ||
              event.leaseToken !== token ||
              event.status !== 'applying' ||
              event.version !== lifecycle.acceptedVersion ||
              !event.leaseUntil ||
              Date.parse(event.leaseUntil) <= this.now().getTime() ||
              !directory ||
              directory.record.status !== 'provisioning' ||
              directory.record.connectionVersion !== recovery.record.connectionVersion ||
              directory.record.credentialBundleVersion !==
                recovery.record.credentialBundleVersion ||
              directory.record.schemaName !== recovery.record.schemaName
            )
              throw new LifecycleFailure('LIFECYCLE_FAILED');
            // Live resource reopen uses runtime admission, so publish after all checks and before hooks.
            await tx.putDirectory({ ...directory.record, status: 'active' }, directory.bundle);
          });
        },
        'LIFECYCLE_RESUME_FAILED',
      ]);
    }

    for (const [phase, failureCode] of phases) {
      const stale = await this.supersedeIfStale(tenantId, eventId, token);
      if (stale) return stale;
      try {
        await phase(tenantId);
      } catch (error) {
        const code = error instanceof LifecycleFailure ? error.code : failureCode;
        // The gate already refuses the tenant; failing here only means the
        // drain is unfinished. Console or the executor retries the event.
        return this.repository.transaction(tenantId, async (tx) => {
          const event = (await tx.getEvent(eventId))!;
          const lifecycle = (await tx.getLifecycle(tenantId))!;
          if (event.leaseToken !== token || event.status !== 'applying')
            return this.toLifecycleResult(event, lifecycle);
          if (event.version !== lifecycle.acceptedVersion)
            await this.finishEvent(tx, event, 'superseded', null);
          else await this.finishEvent(tx, event, 'failed', code);
          return this.toLifecycleResult(event, lifecycle);
        });
      }
    }

    return this.repository.transaction(tenantId, async (tx) => {
      const event = (await tx.getEvent(eventId))!;
      const lifecycle = (await tx.getLifecycle(tenantId))!;
      if (event.leaseToken !== token) return this.toLifecycleResult(event, lifecycle);
      if (event.version !== lifecycle.acceptedVersion || event.status !== 'applying') {
        if (event.status === 'applying') await this.finishEvent(tx, event, 'superseded', null);
        return this.toLifecycleResult(event, lifecycle);
      }
      const blocker = closing ? await tx.tenantStopBlocker(tenantId) : null;
      if (blocker) {
        await this.finishEvent(tx, event, 'failed', blocker);
        return this.toLifecycleResult(event, lifecycle);
      }
      lifecycle.appliedVersion = Math.max(lifecycle.appliedVersion, event.version);
      await tx.putLifecycle(lifecycle);
      await this.finishEvent(tx, event, 'applied', null);
      return this.toLifecycleResult(event, lifecycle);
    });
  }

  private async supersedeIfStale(tenantId: string, eventId: string, leaseToken: string) {
    return this.repository.transaction(tenantId, async (tx) => {
      const event = (await tx.getEvent(eventId))!;
      const lifecycle = (await tx.getLifecycle(tenantId))!;
      if (event.leaseToken !== leaseToken) return this.toLifecycleResult(event, lifecycle);
      if (event.status === 'applying' && event.version === lifecycle.acceptedVersion) {
        event.leaseUntil = this.leaseUntil();
        await tx.putEvent(event);
        return null;
      }
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
    event.leaseToken = null;
    event.leaseUntil = null;
    event.errorCode = errorCode;
    event.observedAt = this.now().toISOString();
    await tx.putEvent(event);
  }

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
