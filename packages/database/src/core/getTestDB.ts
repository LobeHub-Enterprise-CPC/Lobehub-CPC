import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle as nodeDrizzle } from 'drizzle-orm/node-postgres';
import { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite';
import { Pool as NodePool } from 'pg';

import { serverDBEnv } from '@/config/db';

import * as schema from '../schemas';
import {
  materializeTenantStatement,
  TENANT_MIGRATIONS_TABLE,
  TENANT_ONLY_MIGRATIONS_TABLE,
} from '../tenant/migrator';
import type { LobeChatDatabase } from '../type';

// Tests use `public` as the tenant schema: the chains are written for it, and
// queries are unqualified and resolve through the search path, as in a tenant.
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

const chains = [
  { folder: migrationsFolder, journal: TENANT_MIGRATIONS_TABLE },
  { folder: join(migrationsFolder, 'tenant'), journal: TENANT_ONLY_MIGRATIONS_TABLE },
  ...(extraMigrationsFolder
    ? [{ folder: extraMigrationsFolder, journal: '__drizzle_enterprise_migrations' }]
    : []),
];

/**
 * The shared chain, the tenant-only chain and a distribution's extra chain, as the tenant migrator runs
 * them (for `public` the rewrite is a no-op), each followed by its journal
 * rows; pg_search (bm25) is skipped where absent.
 */
const testMigrationStatements = (skipSearchIndexes: boolean) =>
  chains.flatMap(({ folder, journal }) => {
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    return [
      ...migrations.flatMap((migration) =>
        migration.sql
          .map((statement) => materializeTenantStatement(statement, 'public')?.trim())
          .filter(
            (statement): statement is string =>
              !!statement && !(skipSearchIndexes && /pg_search|bm25/i.test(statement)),
          ),
      ),
      `CREATE TABLE IF NOT EXISTS "${journal}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      ...migrations.map(
        (migration) =>
          `INSERT INTO "${journal}" (hash, created_at) VALUES ('${migration.hash}', ${migration.folderMillis})`,
      ),
    ];
  });

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

    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public.users') IS NOT NULL AS exists`,
    );
    if (!rows[0]?.exists) {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      const { rows: search } = await client.query(
        `SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search'`,
      );
      if (search.length > 0) await client.query('CREATE EXTENSION IF NOT EXISTS pg_search');
      for (const statement of testMigrationStatements(search.length === 0))
        await client.query(statement);
    }

    return testServerDB as unknown as LobeChatDatabase;
  }

  // Client DB mode (PGlite)
  if (testClientDB) return testClientDB as unknown as LobeChatDatabase;

  const pglite = new PGlite({ extensions: { vector } });
  testClientDB = pgliteDrizzle({ client: pglite, schema });

  await testClientDB.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  for (const statement of testMigrationStatements(true)) {
    await testClientDB.execute(sql.raw(statement));
  }

  return testClientDB as unknown as LobeChatDatabase;
};
