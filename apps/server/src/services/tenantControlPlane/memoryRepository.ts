import type { DatasourceBundle } from './contracts';
import type {
  ControlPlaneRepository,
  ControlPlaneTx,
  LifecycleEventRecord,
  ProvisionOperationRecord,
  TenantDirectoryRecord,
  TenantLifecycleRecord,
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
  directory = new Map<string, DirectoryEntry>();
  events = new Map<string, LifecycleEventRecord>();
  lifecycles = new Map<string, TenantLifecycleRecord>();
  operationBundles = new Map<string, DatasourceBundle>();
  operations = new Map<string, ProvisionOperationRecord>();

  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(_tenantId: string, fn: (tx: ControlPlaneTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const directory = cloneMap(this.directory);
      const events = cloneMap(this.events);
      const lifecycles = cloneMap(this.lifecycles);
      const operationBundles = cloneMap(this.operationBundles);
      const operations = cloneMap(this.operations);
      const tx: ControlPlaneTx = {
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
        putEvent: async (record) => void events.set(record.eventId, clone(record)),
        putLifecycle: async (record) => void lifecycles.set(record.tenantId, clone(record)),
        putOperation: async (record) => void operations.set(record.operationId, clone(record)),
        putOperationBundle: async (operationId, bundle) =>
          void (bundle
            ? operationBundles.set(operationId, clone(bundle))
            : operationBundles.delete(operationId)),
      };
      const result = await fn(tx);
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
