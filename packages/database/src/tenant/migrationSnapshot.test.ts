import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';

import { readMigrationSnapshot } from './migrationSnapshot';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

const writeChain = async (folder: string, tags: Record<string, string>) => {
  await mkdir(path.join(folder, 'meta'), { recursive: true });
  const entries = Object.keys(tags).map((tag, idx) => ({
    breakpoints: true,
    idx,
    tag,
    version: '7',
    when: 1_700_000_000_000 + idx,
  }));
  await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify({ entries }));
  for (const [tag, query] of Object.entries(tags))
    await writeFile(path.join(folder, `${tag}.sql`), query);
};

describe('migration snapshots', () => {
  it('exactly preserves Drizzle hashes, timestamps and SQL', async () => {
    const folder = path.resolve(__dirname, '../../migrations');
    const snapshot = await readMigrationSnapshot(folder);
    expect(snapshot.migrations).toEqual(readMigrationFiles({ migrationsFolder: folder }));
    expect(await readMigrationSnapshot(folder)).toEqual(snapshot);
  });

  it('sees a migration appended to the chain after an earlier read', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'migration-snapshot-'));
    folders.push(folder);
    await writeChain(folder, { '0000_a': 'CREATE TABLE a (id int);' });
    expect((await readMigrationSnapshot(folder)).migrations).toHaveLength(1);

    await writeChain(folder, {
      '0000_a': 'CREATE TABLE a (id int);',
      '0001_b': 'CREATE TABLE b (id int);\n--> statement-breakpoint\nCREATE TABLE c (id int);',
    });
    const next = await readMigrationSnapshot(folder);
    expect(next.migrations).toEqual(readMigrationFiles({ migrationsFolder: folder }));
    expect(next.migrations[1].sql).toHaveLength(2);
  });

  it('re-reads a migration file whose content changed', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'migration-snapshot-'));
    folders.push(folder);
    await writeChain(folder, { '0000_a': 'CREATE TABLE a (id int);' });
    const before = (await readMigrationSnapshot(folder)).migrations[0].hash;
    await writeChain(folder, { '0000_a': 'CREATE TABLE a (id int, name text);' });
    const after = (await readMigrationSnapshot(folder)).migrations[0].hash;
    expect(after).not.toBe(before);
  });
});
