import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle as nodeDrizzle } from 'drizzle-orm/node-postgres';
import { migrate as nodeMigrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite';
import { Pool as NodePool } from 'pg';

import { serverDBEnv } from '@/config/db';

import * as schema from '../schemas';
import type { LobeChatDatabase } from '../type';

const migrationsFolder = join(__dirname, '../../migrations');

/**
 * Optional second migrations folder, applied after the one above. Lets a
 * downstream distribution that owns extra tables in its own migration chain
 * (outside this repo, so it can't collide with this repo's own migration
 * indices — see `packages/database/migrations`' own guard for why that
 * separation exists) get those tables into the same test database that model
 * tests here run against. A plain env var rather than a hardcoded path: this
 * file ships to every distribution, most of which never set it and see no
 * behavior change.
 */
const extraMigrationsFolder = process.env.TEST_DB_EXTRA_MIGRATIONS_FOLDER;

const isServerDBMode = process.env.TEST_SERVER_DB === '1';

let testClientDB: ReturnType<typeof pgliteDrizzle<typeof schema>> | null = null;
let testServerDB: ReturnType<typeof nodeDrizzle<typeof schema>> | null = null;

export const getTestDB = async (): Promise<LobeChatDatabase> => {
  // Server DB mode (node-postgres)
  if (isServerDBMode) {
    if (testServerDB) return testServerDB as unknown as LobeChatDatabase;

    const connectionString = serverDBEnv.DATABASE_TEST_URL;

    if (!connectionString) {
      throw new Error('DATABASE_TEST_URL is not set');
    }

    const client = new NodePool({ connectionString });
    testServerDB = nodeDrizzle(client, { schema });

    await nodeMigrate(testServerDB, { migrationsFolder });
    if (extraMigrationsFolder) {
      await nodeMigrate(testServerDB, {
        migrationsFolder: extraMigrationsFolder,
        migrationsTable: '__drizzle_enterprise_migrations',
      });
    }

    return testServerDB as unknown as LobeChatDatabase;
  }

  // Client DB mode (PGlite)
  if (testClientDB) return testClientDB as unknown as LobeChatDatabase;

  const pglite = new PGlite({ extensions: { vector } });
  testClientDB = pgliteDrizzle({ client: pglite, schema });

  // Custom migration that skips pg_search-related SQL for PGlite compatibility
  await testClientDB.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await testClientDB.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const applyMigrations = async (folder: string) => {
    for (const migration of readMigrationFiles({ migrationsFolder: folder })) {
      const skipSql = migration.sql.some(
        (s) => s.toLowerCase().includes('pg_search') || s.toLowerCase().includes('bm25'),
      );

      if (!skipSql) {
        for (const stmt of migration.sql) {
          await testClientDB!.execute(sql.raw(stmt));
        }
      }

      await testClientDB!.execute(
        sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`,
      );
    }
  };

  await applyMigrations(migrationsFolder);
  if (extraMigrationsFolder) await applyMigrations(extraMigrationsFolder);

  return testClientDB as unknown as LobeChatDatabase;
};
