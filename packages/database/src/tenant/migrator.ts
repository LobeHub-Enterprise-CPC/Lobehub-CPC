import { existsSync } from 'node:fs';
import path from 'node:path';

import { getTableColumns, getTableName, is } from 'drizzle-orm';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { PgTable } from 'drizzle-orm/pg-core';
import type { ClientBase } from 'pg';

import * as businessSchema from '../schemas';
import { TenantDatabaseError } from './errors';
import { assertTenantMigrationStatementSafe } from './migrationSafety';
import { readMigrationSnapshot } from './migrationSnapshot';
import {
  DEFAULT_SOURCE_SCHEMA,
  matchesReviewedTenantMigration,
  rewriteTenantSchemaQualifiers,
  tenantMigrationSqlWithoutData,
  withoutMigrationHeader,
} from './migrationSql';
import { isTenantSchemaName, tenantDbNames, tenantSearchPathSql } from './names';
import { matchesReviewedSharedOssReissue } from './reissuedMigrations';
import * as tenantSchema from './schemas';

const CREATE_EXTENSION = /^create extension if not exists "?(\w+)"?\s*;?$/i;
const TRANSACTION_CONTROL = /^(?:begin|commit)\s*;?$/i;

// Only this reviewed upstream wrapper is supported. Unknown wrappers remain
// unchanged and are rejected by the execution preflight, never guessed at.
const OPTIONAL_PG_SEARCH = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') THEN
    CREATE EXTENSION IF NOT EXISTS pg_search;
  ELSE
    RAISE NOTICE 'pg_search is not available on this database; skipping BM25 search setup';
  END IF;
END $$;`;

/**
 * One statement of a chain written for `public`, as it runs in a tenant
 * schema, or `null` when it must not run there:
 * - `"public".x` and `public.x` name the tenant schema instead; relation
 *   literals in `to_regclass` and `::regclass` are the only string exceptions;
 * - `CREATE EXTENSION IF NOT EXISTS x` only checks that `x` is installed: the
 *   database baseline installs extensions once in their shared schemas
 *   (`TENANT_EXTENSION_SCHEMAS`) and the schema owner may not create them;
 * - `BEGIN` / `COMMIT` are dropped: the whole chain runs in one transaction.
 * The reviewed optional pg_search wrapper checks installation only when the
 * extension is available; unknown wrappers are rejected before execution.
 * Everything else is unqualified and lands in the tenant through the
 * `search_path` the migrator pins.
 * `sourceSchema` is the schema the chain was authored against: `public`, or the
 * placeholder a distribution generates its chain under (Enterprise: `tenant_template`).
 * It is the only thing that differs between chains; the rules above are the same.
 */
export const materializeTenantStatement = (
  statement: string,
  schemaName: string,
  sourceSchema: string = DEFAULT_SOURCE_SCHEMA,
) => {
  const body = withoutMigrationHeader(statement).trim();
  if (!body || TRANSACTION_CONTROL.test(body)) return null;
  if (matchesReviewedTenantMigration(statement, OPTIONAL_PG_SEARCH)) {
    return `DO $ext$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search')
        AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search') THEN
        RAISE EXCEPTION 'extension pg_search is not installed';
      END IF;
    END $ext$`;
  }
  const extension = CREATE_EXTENSION.exec(body)?.[1];
  if (extension)
    return `DO $ext$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = '${extension}') THEN RAISE EXCEPTION 'extension ${extension} is not installed'; END IF; END $ext$`;
  return rewriteTenantSchemaQualifiers(statement, schemaName, sourceSchema);
};

/**
 * The chain as it runs in `schemaName`. Hashes and timestamps are kept, so the
 * journal in the tenant schema reads like Drizzle's own. Preflight all
 * statements before the runner opens a transaction or sends migration SQL.
 * A chain authored against a placeholder (`sourceSchema`) must not keep naming it
 * after the rewrite, and neither it nor a `public` chain may name `public`.
 */
export const materializeTenantMigrations = (
  migrations: MigrationMeta[],
  schemaName: string,
  sourceSchema: string = DEFAULT_SOURCE_SCHEMA,
): MigrationMeta[] => {
  if (
    !isTenantSchemaName(schemaName) ||
    isTenantSchemaName(sourceSchema) ||
    !/^[_a-z][\d_a-z]*$/.test(sourceSchema)
  )
    throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-name-invalid');
  const leftoverPlaceholder = new RegExp(
    `"${sourceSchema}"|(?<![\\w"$.])${sourceSchema}\\s*\\.`,
    'i',
  );
  return migrations.map((migration) => ({
    ...migration,
    sql: migration.sql.flatMap((statement) => {
      const materialized = materializeTenantStatement(statement, schemaName, sourceSchema);
      if (materialized === null) return [];
      assertTenantMigrationStatementSafe(materialized);
      if (
        sourceSchema !== DEFAULT_SOURCE_SCHEMA &&
        leftoverPlaceholder.test(tenantMigrationSqlWithoutData(materialized))
      )
        // The same public error as every unsafe statement: never echo the SQL.
        throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-failed');
      return [materialized];
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

interface VerifyMigrationHistoryOptions {
  allowPending?: boolean;
  migrationsTable?: string;
  schemaName: string;
}

// Internal authority: only OSS_TENANT_MIGRATOR selects shared-oss. Public
// callers (including Enterprise), arbitrary folders and custom tables remain
// strict. No env/CLI flag or caller-supplied hash set grants this authority.
type HistoryChain = 'strict' | 'shared-oss';

const verifyMigrationHistory = async (
  client: Pick<ClientBase, 'query'>,
  migrationsFolder: string,
  {
    schemaName,
    migrationsTable = TENANT_MIGRATIONS_TABLE,
    allowPending = false,
  }: VerifyMigrationHistoryOptions,
  chain: HistoryChain,
): Promise<number> => {
  if (!isTenantSchemaName(schemaName) || !/^[_a-z][\d_a-z]*$/.test(migrationsTable))
    throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-name-invalid');
  const { migrations, entries: journalEntries } = await readMigrationSnapshot(migrationsFolder);
  // readMigrationFiles does not expose tags. Read the same authoritative
  // journal; never guess the tag from a filename, position or timestamp.
  const entries: unknown[] = chain === 'shared-oss' ? journalEntries : [];
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
        (row.hash !== migrations[index]?.hash &&
          !(
            chain === 'shared-oss' &&
            matchesReviewedSharedOssReissue(row.hash, migrations[index], entries[index], index)
          )) ||
        row.created_at === null ||
        String(row.created_at) !== String(migrations[index]?.folderMillis),
    )
  )
    throw new TenantDatabaseError('TENANT_NOT_READY', 'migration-history-mismatch');
  return applied.rows.length;
};

/** Verify an exact full prefix. Distribution chains never inherit OSS aliases. */
export const verifyTenantMigrationHistory = (
  client: Pick<ClientBase, 'query'>,
  migrationsFolder: string,
  options: VerifyMigrationHistoryOptions,
): Promise<number> => verifyMigrationHistory(client, migrationsFolder, options, 'strict');

/**
 * Runs a tenant migration chain as the schema owner, in one transaction:
 * search_path pinned to the tenant, a per-tenant advisory lock so two
 * processes never migrate the same tenant at once, the journal in the tenant
 * schema (the owner has no database-level CREATE, so Drizzle's own `drizzle`
 * schema is never used). A failure rolls back the tenant's structure and
 * journal together (FR-MD-01).
 */
const runMigrationChain = async (
  client: ClientBase,
  migrationsFolder: string,
  { schemaName, tenantId, migrationsTable = TENANT_MIGRATIONS_TABLE }: RunTenantMigrationsOptions,
  chain: HistoryChain,
): Promise<number> => {
  const migrations = materializeTenantMigrations(
    (await readMigrationSnapshot(migrationsFolder)).migrations,
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
    const appliedCount = await verifyMigrationHistory(
      client,
      migrationsFolder,
      { allowPending: true, migrationsTable, schemaName },
      chain,
    );

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

/** Generic/distribution runner: the exact history policy is always strict. */
export const runTenantMigrations = (
  client: ClientBase,
  migrationsFolder: string,
  options: RunTenantMigrationsOptions,
): Promise<number> => runMigrationChain(client, migrationsFolder, options, 'strict');

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
 * Per-member budget of the root department, as Console sends it at provisioning: `maxBudget` in
 * the stored unit (USD), `budgetDuration: null` never resets. Absent means no limit.
 */
export interface TenantMemberBudget {
  budgetDuration: '1d' | '7d' | '1mo' | null;
  maxBudget: number;
}

/** What the `seed` provision step knows about the tenant it creates. */
export interface TenantSeedContext extends TenantMigrationContext {
  memberBudget: TenantMemberBudget | null;
  name: string;
  slug: string;
}

/**
 * Initial data a distribution writes into a new tenant, in the `seed` provision step: after every
 * chain migrated, on the owner connection, inside the step's transaction with the tenant
 * `search_path` set. It must be idempotent: a failed provision runs the step again. The OSS build
 * has none (`@lobechat/business-tenant`).
 */
export type TenantSeeder = (
  client: Pick<ClientBase, 'query'>,
  context: TenantSeedContext,
) => Promise<void>;

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
  /**
   * Migration executor only (provisioning, `db:migrate`): the exact history after migrating, or a
   * valid prefix before it. Business processes never call it.
   */
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
    await verifyMigrationHistory(client, folder, { schemaName, allowPending }, 'shared-oss');
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
      if (missing.rows.length)
        throw new TenantDatabaseError('TENANT_NOT_READY', 'schema-not-provisioned');
    }
  },
  run: async (client, { schemaName, tenantId }) => {
    await OSS_TENANT_MIGRATOR.verify(client, { schemaName, tenantId }, true);
    const folder = resolveTenantMigrationsFolder();
    await runMigrationChain(client, folder, { schemaName, tenantId }, 'shared-oss');
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
