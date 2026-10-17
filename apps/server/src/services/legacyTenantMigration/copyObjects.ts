import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';

import { TENANT_OBJECT_PREFIX, tenantObjectKey } from '@/server/modules/S3/tenantKey';

/**
 * Moves the objects of a single-tenant release under one tenant's prefix (spec FR-AS-04; Console
 * `docs/legacy-tenant-migration.md`, step 6). The tenant release reads `t/<tenantId>/<key>` only,
 * while the database keeps the logical keys. Objects not referenced from the database (trace
 * snapshots, memory extraction, skill bundles, …) need the same move, so the whole bucket is
 * copied rather than the referenced keys.
 *
 * Copies are additive: legacy objects stay in place until the operator removes them after the
 * tenant is opened. A key the tenant release refuses (`.`/`..`/empty segments, backslashes,
 * control characters) is reported and not copied. `rollback` removes the tenant prefix, which
 * holds nothing but these copies before the tenant is opened.
 */

export interface ObjectStore {
  copy: (from: string, to: string) => Promise<void>;
  delete: (keys: string[]) => Promise<void>;
  /** Every object below `prefix`, with its size in bytes. */
  list: (prefix: string) => Promise<Array<{ key: string; size: number }>>;
}

export type CopyMode = 'apply' | 'dry-run' | 'rollback' | 'verify';

export interface CopyObjectsReport {
  bytes: number;
  copied: number;
  existing: number;
  invalidKeys: string[];
  mismatched: string[];
  missing: string[];
  mode: CopyMode;
  removed: number;
  source: number;
  tenantId: string;
}

/** Physical key of a legacy logical key in the tenant release, via the release's own mapping. */
export const tenantPhysicalKey = (tenantId: string, key: string) =>
  // The key mapping reads only the tenant id from the scope.
  runWithTenantScope({ tenantId } as TenantScope, () => tenantObjectKey(key));

export const copyLegacyObjects = async (input: {
  /** Prefixes that do not belong to the legacy LobeHub (another app sharing the bucket). */
  excludePrefixes?: string[];
  mode: CopyMode;
  store: ObjectStore;
  tenantId: string;
}): Promise<CopyObjectsReport> => {
  const { mode, store, tenantId } = input;
  const root = tenantPhysicalKey(tenantId, 'probe').slice(0, -'probe'.length);
  const report: CopyObjectsReport = {
    bytes: 0,
    copied: 0,
    existing: 0,
    invalidKeys: [],
    mismatched: [],
    missing: [],
    mode,
    removed: 0,
    source: 0,
    tenantId,
  };
  if (mode === 'rollback') {
    const copies = await store.list(root);
    if (copies.length) await store.delete(copies.map((object) => object.key));
    report.removed = copies.length;
    return report;
  }
  const excluded = [`${TENANT_OBJECT_PREFIX}/`, ...(input.excludePrefixes ?? [])];
  const objects = (await store.list('')).filter(
    (object) => !excluded.some((prefix) => object.key.startsWith(prefix)),
  );
  const copies = new Map((await store.list(root)).map((object) => [object.key, object.size]));
  for (const object of objects) {
    let target: string;
    try {
      target = tenantPhysicalKey(tenantId, object.key);
    } catch {
      report.invalidKeys.push(object.key);
      continue;
    }
    report.source++;
    report.bytes += object.size;
    const size = copies.get(target);
    if (size === object.size) {
      report.existing++;
      continue;
    }
    if (size !== undefined) report.mismatched.push(object.key);
    if (mode === 'verify') {
      if (size === undefined) report.missing.push(object.key);
      continue;
    }
    if (mode === 'apply') {
      await store.copy(object.key, target);
      report.copied++;
    }
  }
  return report;
};
