// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { copyLegacyObjects, type ObjectStore } from './copyObjects';

const memoryStore = (initial: Record<string, number>) => {
  const objects = new Map(Object.entries(initial));
  const store: ObjectStore = {
    copy: async (from, to) => {
      objects.set(to, objects.get(from)!);
    },
    delete: async (keys) => {
      for (const key of keys) objects.delete(key);
    },
    list: async (prefix) =>
      [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, size]) => ({ key, size })),
  };
  return { objects, store };
};

describe('legacy object copy', () => {
  const tenantId = 'tenant-alpha';

  it('copies every legacy object under the tenant prefix and reports refused keys', async () => {
    const { objects, store } = memoryStore({
      'admin-images/avatar/u/1.webp': 3,
      'files/2026/doc.pdf': 12,
      'files/bad/../escape': 1,
      'traces/run-1.json': 5,
    });
    const options = { excludePrefixes: ['admin-images/'], store, tenantId };

    const preview = await copyLegacyObjects({ ...options, mode: 'dry-run' });
    expect(preview).toMatchObject({ bytes: 17, copied: 0, invalidKeys: ['files/bad/../escape'] });
    expect(objects.size).toBe(4);
    expect(await copyLegacyObjects({ ...options, mode: 'verify' })).toMatchObject({
      missing: ['files/2026/doc.pdf', 'traces/run-1.json'],
    });

    expect(await copyLegacyObjects({ ...options, mode: 'apply' })).toMatchObject({ copied: 2 });
    expect(objects.get(`t/${tenantId}/files/2026/doc.pdf`)).toBe(12);
    expect(objects.get('files/2026/doc.pdf')).toBe(12);
    expect(objects.has(`t/${tenantId}/admin-images/avatar/u/1.webp`)).toBe(false);

    // Resumable, and verification sees every copy.
    expect(await copyLegacyObjects({ ...options, mode: 'apply' })).toMatchObject({
      copied: 0,
      existing: 2,
    });
    expect(await copyLegacyObjects({ ...options, mode: 'verify' })).toMatchObject({
      missing: [],
      mismatched: [],
    });
  });

  it('rolls back by removing only the tenant prefix', async () => {
    const { objects, store } = memoryStore({
      'files/a': 1,
      [`t/${tenantId}/files/a`]: 1,
      't/other/files/a': 1,
    });
    expect(await copyLegacyObjects({ mode: 'rollback', store, tenantId })).toMatchObject({
      removed: 1,
    });
    expect([...objects.keys()].sort()).toEqual(['files/a', 't/other/files/a']);
  });
});
