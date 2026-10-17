// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { ClientBase } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTenantMigrators, verifyTenantMigrationHistory } from './migrator';

const sourceFolder = path.join(__dirname, '../../migrations');
const originalArgv = process.argv;
const schemaName = 'tenant_0123456789abcdef01234567';
// Independent historical execution identities, not imported from the acceptance rules.
const originalHashes = {
  90: 'f5ff69f21db850b260ca8f3be5e615b78a7425fb030d0ca42a963e9d0c0e0f91',
  93: 'ae390b474eaaacfc943db4762348aac5bbc7a87af1bcdf99737719d04fd7e7bc',
};
type Row = { hash: string; created_at: string | null };

describe('reviewed reissued shared migration history', () => {
  let root: string;
  let folder: string;
  let rows: Row[];
  let query: ReturnType<typeof vi.fn>;
  let client: Pick<ClientBase, 'query'>;
  const shared = getTenantMigrators()[0];
  const context = { schemaName, tenantId: 'reissued-history-fixture' };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'reviewed-reissued-'));
    folder = path.join(root, 'migrations');
    for (const suffix of ['', 'tenant']) {
      const from = path.join(sourceFolder, suffix);
      const to = path.join(folder, suffix);
      mkdirSync(path.join(to, 'meta'), { recursive: true });
      const journal = readFileSync(path.join(from, 'meta/_journal.json'));
      writeFileSync(path.join(to, 'meta/_journal.json'), journal);
      for (const { tag } of JSON.parse(journal.toString()).entries)
        copyFileSync(path.join(from, `${tag}.sql`), path.join(to, `${tag}.sql`));
    }
    rows = readMigrationFiles({ migrationsFolder: folder }).map((migration) => ({
      created_at: String(migration.folderMillis),
      hash: migration.hash,
    }));
    const tenantRows = readMigrationFiles({ migrationsFolder: path.join(folder, 'tenant') }).map(
      (migration) => ({ created_at: String(migration.folderMillis), hash: migration.hash }),
    );
    query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT to_regclass')) return { rows: [{ table: 'fixture' }] };
      if (sql.startsWith('SELECT hash, created_at'))
        return { rows: sql.includes('__lobehub_tenant_migrations') ? tenantRows : rows };
      return { rows: [], rowCount: 0 };
    });
    client = { query } as Pick<ClientBase, 'query'>;
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.argv = originalArgv;
    rmSync(root, { force: true, recursive: true });
  });

  const useOriginal = (indexes: readonly (90 | 93)[] = [90, 93]) => {
    for (const index of indexes) rows[index].hash = originalHashes[index];
  };

  it.each([{ indexes: [] }, { indexes: [90] }, { indexes: [93] }, { indexes: [90, 93] }] as const)(
    'accepts the native or reviewed combination $indexes through the official shared caller, read-only',
    async ({ indexes }) => {
      useOriginal(indexes);
      const before = structuredClone(rows);
      await expect(shared.verify(client, context)).resolves.toBeUndefined();
      expect(rows).toEqual(before);
      expect(query.mock.calls.every(([sql]) => String(sql).trimStart().startsWith('SELECT'))).toBe(
        true,
      );
    },
  );

  it('accepts only a pending tail for migration and rejects that tail for runtime', async () => {
    useOriginal();
    rows.pop();
    await expect(shared.verify(client, context, true)).resolves.toBeUndefined();
    await expect(shared.verify(client, context)).rejects.toMatchObject({
      reason: 'migration-history-mismatch',
    });
  });

  it.each(['__drizzle_migrations', '__lobehub_tenant_migrations', '__enterprise_migrations'])(
    'does not authorize aliases by arbitrary directory or table name %s',
    async (migrationsTable) => {
      useOriginal();
      // The public helper remains strict even for an exact copy of the official files.
      query.mockImplementation(async (sql: string) =>
        sql.startsWith('SELECT to_regclass') ? { rows: [{ table: 'fixture' }] } : { rows },
      );
      await expect(
        verifyTenantMigrationHistory(client, folder, { migrationsTable, schemaName }),
      ).rejects.toMatchObject({ reason: 'migration-history-mismatch' });
    },
  );

  it.each([
    'unknown-hash',
    'wrong-time',
    'changed-journal-time',
    'null-time',
    'wrong-tag',
    'wrong-index',
    'changed-target',
    'reversed-target',
    'alias-on-another-row',
    'missing-prefix',
    'duplicate',
    'reordered',
    'extra-row',
    'bad-row-after-alias',
    'external-permission',
  ])('rejects %s with and without allowPending, without changing any history', async (mutation) => {
    useOriginal();
    const journalFile = path.join(folder, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    switch (mutation) {
      case 'unknown-hash': {
        rows[90].hash = 'a'.repeat(64);
        break;
      }
      case 'wrong-time': {
        rows[90].created_at = String(Number(rows[90].created_at) + 1);
        break;
      }
      case 'null-time': {
        rows[90].created_at = null;
        break;
      }
      case 'changed-journal-time': {
        journal.entries[90].when += 1;
        rows[90].created_at = String(journal.entries[90].when);
        writeFileSync(journalFile, JSON.stringify(journal));
        break;
      }
      case 'wrong-tag': {
        const entry = journal.entries[90];
        copyFileSync(path.join(folder, `${entry.tag}.sql`), path.join(folder, '0090_other.sql'));
        entry.tag = '0090_other';
        writeFileSync(journalFile, JSON.stringify(journal));
        break;
      }
      case 'wrong-index': {
        journal.entries[90].idx = 89;
        writeFileSync(journalFile, JSON.stringify(journal));
        break;
      }
      case 'changed-target': {
        const file = path.join(folder, '0090_enable_pg_search.sql');
        writeFileSync(file, readFileSync(file, 'utf8') + '\n-- future reissue\n');
        break;
      }
      case 'reversed-target': {
        rows[90].hash = readMigrationFiles({ migrationsFolder: folder })[90].hash;
        writeFileSync(
          path.join(folder, '0090_enable_pg_search.sql'),
          '-- Custom SQL migration file, put your code below! --\nCREATE EXTENSION IF NOT EXISTS pg_search;',
        );
        break;
      }
      case 'alias-on-another-row': {
        rows[91].hash = originalHashes[90];
        break;
      }
      case 'missing-prefix': {
        rows.splice(1, 1);
        break;
      }
      case 'duplicate': {
        rows.splice(91, 0, { ...rows[90] });
        break;
      }
      case 'reordered': {
        [rows[90], rows[93]] = [rows[93], rows[90]];
        break;
      }
      case 'extra-row': {
        rows.push({ ...rows[0] });
        break;
      }
      case 'bad-row-after-alias': {
        rows[100].hash = 'b'.repeat(64);
        break;
      }
      case 'external-permission': {
        rows[90].hash = 'c'.repeat(64);
        vi.stubEnv('TENANT_MIGRATION_ACCEPTED_HASHES', rows[90].hash);
        vi.stubEnv('TENANT_MIGRATION_CHAIN', 'shared-oss');
        process.argv = ['node', 'migrate', '--accept-migration-hash=' + rows[90].hash];
        break;
      }
    }
    const before = structuredClone(rows);
    for (const allowPending of [false, true])
      await expect(shared.verify(client, context, allowPending)).rejects.toMatchObject({
        reason: 'migration-history-mismatch',
      });
    expect(rows).toEqual(before);
  });
});
