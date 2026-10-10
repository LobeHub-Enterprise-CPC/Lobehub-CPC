import { existsSync } from 'node:fs';
import path from 'node:path';

import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator';
import { PgTable } from 'drizzle-orm/pg-core';
import type { ClientBase } from 'pg';

import * as businessSchema from '../schemas';
import { TenantDatabaseError } from './errors';
import { isTenantSchemaName, tenantDbNames, tenantSearchPathSql } from './names';
import * as tenantSchema from './schemas';

// `"public".users`, `public.users`, `'public.t'::regclass`; not `is_public.` or `"t"."public".`.
const QUOTED_PUBLIC = /(?<![\w".])"public"\./g;
const BARE_PUBLIC = /(?<![\w"$.])public\.(?=["A-Z_a-z])/g;
const CREATE_EXTENSION = /^create extension if not exists "?(\w+)"?\s*;?$/i;
const TRANSACTION_CONTROL = /^(?:begin|commit)\s*;?$/i;

const withoutComments = (statement: string) =>
  statement
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();

/**
 * One statement of a chain written for `public`, as it runs in a tenant
 * schema, or `null` when it must not run there:
 * - `"public".x` and `public.x` (also inside literals such as
 *   `'public.t'::regclass`) name the tenant schema instead;
 * - `CREATE EXTENSION IF NOT EXISTS x` only checks that `x` is installed: the
 *   database baseline installs extensions once in their shared schemas
 *   (`TENANT_EXTENSION_SCHEMAS`) and the schema owner may not create them;
 * - `BEGIN` / `COMMIT` are dropped: the whole chain runs in one transaction.
 * Everything else is unqualified and lands in the tenant through the
 * `search_path` the migrator pins.
 */
export const materializeTenantStatement = (statement: string, schemaName: string) => {
  const body = withoutComments(statement);
  if (!body || TRANSACTION_CONTROL.test(body)) return null;
  const extension = CREATE_EXTENSION.exec(body)?.[1];
  if (extension)
    return `DO $ext$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = '${extension}') THEN RAISE EXCEPTION 'extension ${extension} is not installed'; END IF; END $ext$`;
  const target = `"${schemaName}".`;
  return statement.replaceAll(QUOTED_PUBLIC, target).replaceAll(BARE_PUBLIC, target);
};

/**
 * The chain as it runs in `schemaName`. Hashes and timestamps are kept, so the
 * journal in the tenant schema reads like Drizzle's own.
 */
export const materializeTenantMigrations = (
  migrations: MigrationMeta[],
  schemaName: string,
): MigrationMeta[] => {
  if (!isTenantSchemaName(schemaName))
    throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-name-invalid');
  return migrations.map((migration) => ({
    ...migration,
    sql: migration.sql.flatMap((statement) => {
      const materialized = materializeTenantStatement(statement, schemaName);
      return materialized === null ? [] : [materialized];
    }),
  }));
};

/** Journal of the shared chain, inside the tenant schema (FR-MD-01). */
export const TENANT_MIGRATIONS_TABLE = '__drizzle_migrations';

/** Journal of the tenant-only chain (`migrations/tenant`), inside the tenant schema. */
export const TENANT_ONLY_MIGRATIONS_TABLE = '__lobehub_tenant_migrations';

export interface RunTenantMigrationsOptions {
  /** Journal table; the Enterprise chain keeps its own. */
  migrationsTable?: string;
  schemaName: string;
  tenantId: string;
}

/** Verify the entire applied prefix, never just the most recent timestamp. */
export const verifyTenantMigrationHistory = async (
  client: Pick<ClientBase, 'query'>,
  migrationsFolder: string,
  {
    schemaName,
    migrationsTable = TENANT_MIGRATIONS_TABLE,
    allowPending = false,
  }: {
    allowPending?: boolean;
    migrationsTable?: string;
    schemaName: string;
  },
): Promise<number> => {
  if (!isTenantSchemaName(schemaName) || !/^[_a-z][\d_a-z]*$/.test(migrationsTable))
    throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-name-invalid');
  const migrations = readMigrationFiles({ migrationsFolder });
  const journal = `"${schemaName}"."${migrationsTable}"`;
  const exists = await client.query<{ table: string | null }>('SELECT to_regclass($1) AS table', [
    journal,
  ]);
  if (!exists.rows[0]?.table) {
    if (allowPending) return 0;
    throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-history-mismatch');
  }
  const applied = await client.query<{ hash: string; created_at: string | null }>(
    `SELECT hash, created_at FROM ${journal} ORDER BY id`,
  );
  if (
    applied.rows.length > migrations.length ||
    (!allowPending && applied.rows.length !== migrations.length) ||
    applied.rows.some(
      (row, index) =>
        row.hash !== migrations[index]?.hash ||
        row.created_at === null ||
        String(row.created_at) !== String(migrations[index]?.folderMillis),
    )
  )
    throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-history-mismatch');
  return applied.rows.length;
};

/**
 * Runs a tenant migration chain as the schema owner, in one transaction:
 * search_path pinned to the tenant, a per-tenant advisory lock so two
 * processes never migrate the same tenant at once, the journal in the tenant
 * schema (the owner has no database-level CREATE, so Drizzle's own `drizzle`
 * schema is never used). A failure rolls back the tenant's structure and
 * journal together (FR-MD-01).
 */
export const runTenantMigrations = async (
  client: ClientBase,
  migrationsFolder: string,
  { schemaName, tenantId, migrationsTable = TENANT_MIGRATIONS_TABLE }: RunTenantMigrationsOptions,
): Promise<number> => {
  const migrations = materializeTenantMigrations(
    readMigrationFiles({ migrationsFolder }),
    schemaName,
  );
  if (!/^[_a-z][\d_a-z]*$/.test(migrationsTable)) throw new Error('INVALID_MIGRATIONS_TABLE');
  const journal = `"${schemaName}"."${migrationsTable}"`;

  await client.query('BEGIN');
  try {
    const owned = await client.query<{ owned: boolean }>(
      `SELECT current_user = $2 AND pg_get_userbyid(nspowner) = $2 AS owned
         FROM pg_namespace WHERE nspname = $1`,
      [schemaName, tenantDbNames(tenantId).ownerUsername],
    );
    if (!owned.rows[0]?.owned)
      throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-not-provisioned');

    await client.query(tenantSearchPathSql(schemaName));
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `lobehub:tenant-migration:${tenantId}`,
    ]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${journal} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    const appliedCount = await verifyTenantMigrationHistory(client, migrationsFolder, {
      allowPending: true,
      migrationsTable,
      schemaName,
    });

    let applied = 0;
    for (const migration of migrations.slice(appliedCount)) {
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(`INSERT INTO ${journal} (hash, created_at) VALUES ($1, $2)`, [
        migration.hash,
        migration.folderMillis,
      ]);
      applied += 1;
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof TenantDatabaseError) throw error;
    throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-failed', { cause: error });
  }
};

/**
 * The shared chain (`packages/database/migrations`, the one `db:generate`
 * writes) in the repository layout and in the Docker image (`/app/migrations`,
 * see Dockerfile). Its `tenant` folder holds the tenant-only chain.
 */
export const resolveTenantMigrationsFolder = (
  cwd = process.cwd(),
  exists: (path: string) => boolean = existsSync,
): string => {
  const candidates = [
    path.join(cwd, 'packages/database/migrations'),
    path.join(cwd, 'migrations'),
    path.join(cwd, '../../packages/database/migrations'),
  ];
  const found = candidates.find(
    (candidate) =>
      exists(path.join(candidate, 'meta/_journal.json')) &&
      exists(path.join(candidate, 'tenant/meta/_journal.json')),
  );
  if (!found) throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-failed');
  return found;
};

export interface TenantMigrationContext {
  schemaName: string;
  tenantId: string;
}

/**
 * One migration chain run inside every tenant schema, on the tenant owner
 * connection, after the chains registered before it. The OSS chain is always
 * first. Distributions append theirs (e.g. Enterprise registers
 * `runEnterpriseTenantMigrations`, which needs the OSS `users` table) through
 * {@link registerTenantMigrator}; OSS code never imports them.
 */
export interface TenantMigrator {
  /** Journal tables the chain keeps in the tenant schema; the runtime role only reads them. */
  journalTables: readonly string[];
  name: string;
  run: (client: ClientBase, context: TenantMigrationContext) => Promise<unknown>;
  /** Exact history for readiness, or a valid prefix before migration. */
  verify: (
    client: Pick<ClientBase, 'query'>,
    context: TenantMigrationContext,
    allowPending?: boolean,
  ) => Promise<unknown>;
}

/**
 * The shared chain replayed in the tenant schema, then the tenant-only tables.
 * Each keeps its own journal, since a journal resumes after its newest entry.
 */
const OSS_TENANT_MIGRATOR: TenantMigrator = {
  journalTables: [TENANT_MIGRATIONS_TABLE, TENANT_ONLY_MIGRATIONS_TABLE],
  name: 'lobehub',
  verify: async (client, { schemaName }, allowPending = false) => {
    const folder = resolveTenantMigrationsFolder();
    await verifyTenantMigrationHistory(client, folder, { schemaName, allowPending });
    await verifyTenantMigrationHistory(client, path.join(folder, 'tenant'), {
      migrationsTable: TENANT_ONLY_MIGRATIONS_TABLE,
      schemaName,
      allowPending,
    });
    if (!allowPending) {
      const tables = Object.values({ ...businessSchema, ...tenantSchema }).filter((table) =>
        is(table, PgTable),
      );
      const expected = tables.flatMap((table) =>
        Object.values(getTableColumns(table)).map((column) => ({
          table: getTableName(table),
          column: column.name,
        })),
      );
      const missing = await client.query(
        `SELECT 1 FROM unnest($2::text[], $3::text[]) expected(table_name, column_name)
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = expected.table_name
               AND c.relkind IN ('r', 'p') AND a.attname = expected.column_name
               AND a.attnum > 0 AND NOT a.attisdropped
          ) LIMIT 1`,
        [schemaName, expected.map((item) => item.table), expected.map((item) => item.column)],
      );
      if (missing.rowCount)
        throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-not-provisioned');
    }
  },
  run: async (client, { schemaName, tenantId }) => {
    await OSS_TENANT_MIGRATOR.verify(client, { schemaName, tenantId }, true);
    const folder = resolveTenantMigrationsFolder();
    await runTenantMigrations(client, folder, { schemaName, tenantId });
    await runTenantMigrations(client, path.join(folder, 'tenant'), {
      migrationsTable: TENANT_ONLY_MIGRATIONS_TABLE,
      schemaName,
      tenantId,
    });
  },
};

const migrators: TenantMigrator[] = [OSS_TENANT_MIGRATOR];

/** Appends a post-OSS tenant chain. Registering the same name twice is a no-op. */
export const registerTenantMigrator = (migrator: TenantMigrator) => {
  if (!migrators.some((existing) => existing.name === migrator.name)) migrators.push(migrator);
};

/** Registered chains in run order: OSS first. */
export const getTenantMigrators = (): readonly TenantMigrator[] => migrators;

/** Runs every registered chain for one tenant, in order, as the schema owner. */
export const migrateTenantSchema = async (client: ClientBase, context: TenantMigrationContext) => {
  for (const migrator of migrators) await migrator.verify(client, context, true);
  for (const migrator of migrators) await migrator.run(client, context);
};
