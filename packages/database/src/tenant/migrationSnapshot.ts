import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { MigrationMeta } from 'drizzle-orm/migrator';

interface JournalEntry {
  breakpoints: boolean;
  tag: string;
  when: number;
}
interface MigrationSnapshot {
  entries: JournalEntry[];
  migrations: MigrationMeta[];
}
interface MigrationFile {
  hash: string;
  query: string;
}

const files = new Map<string, { read: Promise<MigrationFile>; signature: string }>();

/**
 * Reading and hashing the chains is the expensive part and a release never changes it, so each file
 * is read once while its mtime and size stay the same. The journal is cheap and read every time:
 * a chain that gains or changes a migration is never answered from a stale snapshot.
 */
const readMigrationFile = async (file: string): Promise<MigrationFile> => {
  const { mtimeMs, size } = await stat(file);
  const signature = `${mtimeMs}:${size}`;
  const cached = files.get(file);
  if (cached?.signature === signature) return cached.read;
  const read = (async () => {
    const query = await readFile(file, 'utf8');
    return { hash: createHash('sha256').update(query).digest('hex'), query };
  })();
  files.set(file, { read, signature });
  void read.catch(() => {
    if (files.get(file)?.read === read) files.delete(file);
  });
  return read;
};

/** Same result as Drizzle's readMigrationFiles, without blocking the event loop on every call. */
export const readMigrationSnapshot = async (folder: string): Promise<MigrationSnapshot> => {
  const resolved = path.resolve(folder);
  const { entries } = JSON.parse(
    await readFile(path.join(resolved, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const migrations = await Promise.all(
    entries.map(async (entry) => {
      const { hash, query } = await readMigrationFile(path.join(resolved, `${entry.tag}.sql`));
      return {
        bps: entry.breakpoints,
        folderMillis: entry.when,
        hash,
        sql: query.split('--> statement-breakpoint'),
      };
    }),
  );
  return { entries, migrations };
};
