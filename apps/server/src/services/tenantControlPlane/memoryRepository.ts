import type { DestructionRecord } from '@/server/modules/Tenant/destruction';

import { ControlPlaneError, type DatasourceBundle } from './contracts';
import type {
  ControlPlaneRepository,
  ControlPlaneTx,
  DrainObservation,
  LifecycleEventRecord,
  ProvisionOperationRecord,
  TenantDirectoryRecord,
  TenantLifecycleRecord,
  TransactionOptions,
} from './repository';

const clone = <T>(value: T): T => structuredClone(value);
const cloneMap = <K, V>(map: Map<K, V>) => new Map([...map].map(([k, v]) => [k, clone(v)]));

interface DirectoryEntry {
  bundle: DatasourceBundle;
  record: TenantDirectoryRecord;
}

/**
 * In-process repository for tests. Transactions run one at a time and only
 * commit when `fn` resolves, matching the rollback behaviour of the real one.
 */
export class MemoryControlPlaneRepository implements ControlPlaneRepository {
  stopBlockers = new Map<string, 'LIFECYCLE_STOP_UNCONFIRMED'>();
  /** Destruction drain inputs a test sets: runtime processes and incomplete external work. */
  drainBlockers = new Map<string, Pick<DrainObservation, 'externalWork' | 'processes'>>();
  /** Items the Postgres repository also removes: stored here so a test can seed and inspect them. */
  endpointRecords = new Set<string>();
  externalWork = new Set<string>();
  destructions = new Map<string, DestructionRecord>();
  directory = new Map<string, DirectoryEntry>();
  events = new Map<string, LifecycleEventRecord>();
  lifecycles = new Map<string, TenantLifecycleRecord>();
  operationBundles = new Map<string, DatasourceBundle>();
  operations = new Map<string, ProvisionOperationRecord>();

  private queue: Promise<unknown> = Promise.resolve();

  async readDestruction(tenantId: string) {
    const record = this.destructions.get(tenantId);
    return record ? clone(record) : null;
  }

  transaction<T>(
    tenantId: string,
    fn: (tx: ControlPlaneTx) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const run = async () => {
      const destructions = cloneMap(this.destructions);
      if (!options.destruction && destructions.has(tenantId))
        throw new ControlPlaneError(409, 'TENANT_DESTROYED');
      const endpointRecords = new Set(this.endpointRecords);
      const externalWork = new Set(this.externalWork);
      const directory = cloneMap(this.directory);
      const events = cloneMap(this.events);
      const lifecycles = cloneMap(this.lifecycles);
      const operationBundles = cloneMap(this.operationBundles);
      const operations = cloneMap(this.operations);
      const tx: ControlPlaneTx = {
        createDestruction: async (id, destroyOperationId, terminalEstablishedAt) => {
          if (!destructions.has(id))
            destructions.set(id, {
              completedAt: null,
              destroyOperationId,
              drainResult: null,
              tenantId: id,
              terminalEstablishedAt,
            });
          return clone(destructions.get(id)!);
        },
        fenceInFlight: async (id) => {
          for (const op of operations.values())
            if (op.tenantId === id && op.status === 'applying')
              Object.assign(op, { leaseToken: null, leaseUntil: null });
          for (const event of events.values())
            if (event.tenantId === id && event.status === 'applying')
              Object.assign(event, { leaseToken: null, leaseUntil: null });
        },
        finishDrain: async (id, result) => {
          const record = destructions.get(id)!;
          record.drainResult ??= result;
          return clone(record);
        },
        getDestruction: async (id) => {
          const record = destructions.get(id);
          return record ? clone(record) : null;
        },
        observeDrain: async (id, now) => {
          const live = (until?: string | null) => !!until && Date.parse(until) > now.getTime();
          return {
            externalWork: this.drainBlockers.get(id)?.externalWork ?? false,
            liveOperations:
              [...operations.values()].filter(
                (op) => op.tenantId === id && op.status === 'applying' && live(op.leaseUntil),
              ).length +
              [...events.values()].filter(
                (event) =>
                  event.tenantId === id && event.status === 'applying' && live(event.leaseUntil),
              ).length,
            processes: this.drainBlockers.get(id)?.processes ?? false,
          };
        },
        unregisterTenant: async (id, completedAt, pool) => {
          const had = (done: boolean) => (done ? ('deleted' as const) : ('absent' as const));
          const ownOperations = [...operations.values()].filter((op) => op.tenantId === id);
          const ownEvents = [...events.values()].filter((event) => event.tenantId === id);
          const hadPending = ownOperations.some((op) => operationBundles.has(op.operationId));
          const hadDirectory = directory.delete(id);
          const hadLifecycle = lifecycles.delete(id);
          for (const op of ownOperations) {
            operations.delete(op.operationId);
            operationBundles.delete(op.operationId);
          }
          for (const event of ownEvents) events.delete(event.eventId);
          const hadEndpoints = endpointRecords.delete(id);
          const hadExternal = externalWork.delete(id);
          const record = destructions.get(id)!;
          record.completedAt ??= completedAt;
          return [
            { item: 'tenant_directory', result: had(hadDirectory) },
            { item: 'active_connection', result: had(hadDirectory) },
            { item: 'credential_bundle', result: had(hadDirectory || hadPending) },
            {
              item: 'control_plane_operations',
              result: had(
                hadLifecycle || hadExternal || ownOperations.length > 0 || ownEvents.length > 0,
              ),
            },
            { item: 'endpoint_records', result: had(hadEndpoints) },
            { item: 'connection_pool', result: pool },
          ];
        },
        tenantStopBlocker: async (tenantId) => this.stopBlockers.get(tenantId) ?? null,
        findEventByVersion: async (tenantId, version) =>
          [...events.values()].find((e) => e.tenantId === tenantId && e.version === version) ??
          null,
        findTenantBySlug: async (slug) =>
          [...operations.values()].find((o) => o.slug === slug)?.tenantId ?? null,
        getDirectory: async (tenantId) => {
          const entry = directory.get(tenantId);
          return entry ? clone(entry) : null;
        },
        getEvent: async (eventId) => events.get(eventId) ?? null,
        getLifecycle: async (tenantId) => lifecycles.get(tenantId) ?? null,
        getOperation: async (operationId) => operations.get(operationId) ?? null,
        getOperationBundle: async (operationId) => {
          const bundle = operationBundles.get(operationId);
          return bundle ? clone(bundle) : null;
        },
        listOpenEvents: async (tenantId) =>
          [...events.values()].filter(
            (e) =>
              e.tenantId === tenantId &&
              (e.status === 'received' || e.status === 'applying' || e.status === 'failed'),
          ),
        listOperations: async (tenantId) =>
          [...operations.values()].filter((o) => o.tenantId === tenantId),
        putDirectory: async (record, bundle) =>
          void directory.set(record.tenantId, { bundle: clone(bundle), record: clone(record) }),
        putEvent: async (record) => {
          const existing = events.get(record.eventId);
          if (
            existing &&
            (existing.tenantId !== record.tenantId ||
              existing.payloadHash !== record.payloadHash ||
              existing.version !== record.version)
          )
            throw new ControlPlaneError(409, 'LIFECYCLE_EVENT_CONFLICT');
          events.set(record.eventId, clone(record));
        },
        putLifecycle: async (record) => void lifecycles.set(record.tenantId, clone(record)),
        putOperation: async (record) => {
          const existing = operations.get(record.operationId);
          if (
            existing &&
            (existing.tenantId !== record.tenantId || existing.inputHash !== record.inputHash)
          )
            throw new ControlPlaneError(409, 'VERSION_CONFLICT');
          operations.set(record.operationId, clone(record));
        },
        putOperationBundle: async (operationId, bundle) =>
          void (bundle
            ? operationBundles.set(operationId, clone(bundle))
            : operationBundles.delete(operationId)),
      };
      const result = await fn(tx);
      this.destructions = destructions;
      this.endpointRecords = endpointRecords;
      this.externalWork = externalWork;
      this.directory = directory;
      this.events = events;
      this.lifecycles = lifecycles;
      this.operationBundles = operationBundles;
      this.operations = operations;
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
