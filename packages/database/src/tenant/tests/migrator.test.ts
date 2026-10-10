// @vitest-environment node
/**
 * The shared migration chain (`packages/database/migrations`, written for
 * `public`) is replayed in every tenant schema. These tests keep every
 * migration, including ones canary adds later, inside the tenant schema:
 * a new migration that creates or touches an object elsewhere fails here.
 */
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { TenantDatabaseError } from '../errors';
import {
  getTenantMigrators,
  materializeTenantMigrations,
  materializeTenantStatement,
  TENANT_MIGRATIONS_TABLE,
  TENANT_ONLY_MIGRATIONS_TABLE,
} from '../migrator';
import { tenantDbNames } from '../names';

const SCHEMA = 'tenant_0123456789abcdef01234567';
const migrationsFolder = path.join(__dirname, '../../../migrations');
const chains = [migrationsFolder, path.join(migrationsFolder, 'tenant')];

const materializedChains = () =>
  chains.flatMap((folder) =>
    materializeTenantMigrations(readMigrationFiles({ migrationsFolder: folder }), SCHEMA),
  );

/** Every object outside `schema`, so a replay can be checked for strays. */
const OBJECTS_OUTSIDE_SQL = (schema: string) => `
  SELECT 'class:' || n.nspname || '.' || c.relname AS object
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('${schema}', 'pg_toast') AND n.nspname !~ '^pg_(toast_)?temp_'
  UNION ALL
  SELECT 'proc:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname <> '${schema}'
  UNION ALL
  SELECT 'type:' || n.nspname || '.' || t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname <> '${schema}'
  UNION ALL
  SELECT 'constraint:' || n.nspname || '.' || k.conname
    FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname <> '${schema}'
  UNION ALL
  SELECT 'trigger:' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname <> '${schema}'
  UNION ALL
  SELECT 'extension:' || extname FROM pg_extension
  UNION ALL
  SELECT 'schema:' || nspname FROM pg_namespace
   WHERE nspname <> '${schema}' AND nspname !~ '^pg_(toast_)?temp_'
`;

const objectsOutside = async (
  query: (sql: string) => Promise<{ rows: { object: string }[] }>,
  schema: string,
) => new Set((await query(OBJECTS_OUTSIDE_SQL(schema))).rows.map((row) => row.object));

describe('materializeTenantStatement', () => {
  it('points "public" and bare public. qualifiers at the tenant schema', () => {
    expect(
      materializeTenantStatement(
        'ALTER TABLE "files" ADD CONSTRAINT "fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")',
        SCHEMA,
      ),
    ).toBe(
      `ALTER TABLE "files" ADD CONSTRAINT "fk" FOREIGN KEY ("user_id") REFERENCES "${SCHEMA}"."users"("id")`,
    );
    expect(
      materializeTenantStatement(
        "SELECT to_regclass('public.topic_comments'), 'public.goal_nodes'::regclass",
        SCHEMA,
      ),
    ).toBe(`SELECT to_regclass('"${SCHEMA}".topic_comments'), '"${SCHEMA}".goal_nodes'::regclass`);
  });

  it('leaves the word public alone when it is not a schema qualifier', () => {
    const statement = `ALTER TABLE "agents" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL; SELECT is_public.x, "a"."public".y`;
    expect(materializeTenantStatement(statement, SCHEMA)).toBe(statement);
  });

  it('turns CREATE EXTENSION into a check that the shared extension is installed', () => {
    const statement = materializeTenantStatement(
      '-- Custom SQL migration file, put your code below! --\nCREATE EXTENSION IF NOT EXISTS pg_search;',
      SCHEMA,
    );
    expect(statement).not.toMatch(/create extension/i);
    expect(statement).toContain("extname = 'pg_search'");
  });

  it('drops transaction control, since the chain runs in one transaction', () => {
    expect(materializeTenantStatement('\nBEGIN;', SCHEMA)).toBeNull();
    expect(materializeTenantStatement('\n\nCOMMIT;', SCHEMA)).toBeNull();
    expect(materializeTenantStatement('-- only a comment\n', SCHEMA)).toBeNull();
  });

  it('refuses a schema that is not a tenant schema', () => {
    expect(() => materializeTenantMigrations([], 'public')).toThrow(TenantDatabaseError);
  });
});

describe('the shared and tenant-only chains', () => {
  it('keep their Drizzle hashes and timestamps', () => {
    const original = readMigrationFiles({ migrationsFolder });
    const materialized = materializeTenantMigrations(original, SCHEMA);
    expect(materialized.map((m) => [m.hash, m.folderMillis])).toEqual(
      original.map((m) => [m.hash, m.folderMillis]),
    );
  });

  it('never name another schema or change where objects are created', () => {
    const offending = materializedChains()
      .flatMap((migration) => migration.sql)
      .filter(
        (statement) =>
          /"public"|(?<![\w"$.])public\./i.test(statement) ||
          /\bcreate\s+(?:schema|extension)\b/i.test(statement) ||
          /\bset\s+(?:local\s+|session\s+)?(?:search_path|role|session\s+authorization)\b/i.test(
            statement,
          ) ||
          /\bset_config\s*\(\s*'search_path'/i.test(statement) ||
          /\bset\s+schema\b/i.test(statement) ||
          /\b(?:alter|drop)\s+(?:database|extension|schema)\b/i.test(statement),
      );
    expect(offending).toEqual([]);
  });

  it('replays into a tenant schema without creating anything outside it', async () => {
    const pglite = new PGlite({ extensions: { vector } });
    await pglite.exec('CREATE EXTENSION IF NOT EXISTS vector');
    await pglite.exec(`CREATE SCHEMA "${SCHEMA}"`);
    const query = (sql: string) => pglite.query<{ object: string }>(sql);
    const before = await objectsOutside(query, SCHEMA);

    // pg_search is not available in PGlite; the real-PostgreSQL case covers bm25.
    await pglite.exec(`SET search_path TO "${SCHEMA}", public`);
    for (const migration of materializedChains())
      for (const statement of migration.sql)
        if (!/pg_search|bm25/i.test(statement)) await pglite.exec(statement);

    const after = await objectsOutside(query, SCHEMA);
    expect([...after].filter((object) => !before.has(object))).toEqual([]);

    const { rows } = await pglite.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2)`,
      [SCHEMA, ['users', 'messages', 'sso_providers', 'tenant_metadata']],
    );
    expect(rows.map((row) => row.name).sort()).toEqual([
      'messages',
      'sso_providers',
      'tenant_metadata',
      'users',
    ]);
    await pglite.close();
  }, 120_000);
});

const ADMIN_URL = process.env.TEST_SERVER_DB === '1' ? process.env.DATABASE_TEST_URL : undefined;

/**
 * The tenant migrator itself on a real PostgreSQL with pg_search, as a schema
 * owner that has no privilege outside its schema (spec FR-DI-06).
 */
describe.skipIf(!ADMIN_URL)('tenant migrator on PostgreSQL', () => {
  it('replays both chains as the schema owner and leaves nothing outside the schema', async () => {
    const tenantId = `replay-${process.pid}-${Date.now()}`;
    const names = tenantDbNames(tenantId);
    const database = `lh_tenant_replay_${process.pid}_${Date.now() % 100_000}`;
    const dbUrl = (user?: string) => {
      const url = new URL(ADMIN_URL!);
      url.pathname = `/${database}`;
      if (user) {
        url.username = user;
        url.password = `${user}-pw`;
      }
      return url.toString();
    };

    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE "${database}"`);
    const admin = new Client({ connectionString: dbUrl() });
    const owner = new Client({ connectionString: dbUrl(names.ownerUsername) });
    try {
      await admin.connect();
      // The database baseline Console provides: extensions installed once in
      // their shared schemas, nothing for tenant roles in `public`.
      await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
      await admin.query('CREATE EXTENSION IF NOT EXISTS pg_search');
      await admin.query('CREATE SCHEMA IF NOT EXISTS extensions');
      await admin.query('ALTER EXTENSION vector SET SCHEMA extensions');
      await admin.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC`);
      await admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM PUBLIC`);
      await admin.query(`DROP ROLE IF EXISTS "${names.ownerUsername}"`);
      await admin.query(
        `CREATE ROLE "${names.ownerUsername}" LOGIN PASSWORD '${names.ownerUsername}-pw'`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA extensions, paradedb TO "${names.ownerUsername}"`);
      await admin.query(
        `CREATE SCHEMA "${names.schemaName}" AUTHORIZATION "${names.ownerUsername}"`,
      );
      const query = (sql: string) => admin.query<{ object: string }>(sql);
      const before = await objectsOutside(query, names.schemaName);

      await owner.connect();
      const [oss] = getTenantMigrators();
      await oss.run(owner, { schemaName: names.schemaName, tenantId });

      const after = await objectsOutside(query, names.schemaName);
      expect([...after].filter((object) => !before.has(object))).toEqual([]);

      const journals = await admin.query<{ journal: string; rows: string }>(
        `SELECT '${TENANT_MIGRATIONS_TABLE}' AS journal, count(*)::text AS rows FROM "${names.schemaName}"."${TENANT_MIGRATIONS_TABLE}"
         UNION ALL
         SELECT '${TENANT_ONLY_MIGRATIONS_TABLE}', count(*)::text FROM "${names.schemaName}"."${TENANT_ONLY_MIGRATIONS_TABLE}"`,
      );
      expect(journals.rows).toEqual([
        {
          journal: TENANT_MIGRATIONS_TABLE,
          rows: String(readMigrationFiles({ migrationsFolder }).length),
        },
        {
          journal: TENANT_ONLY_MIGRATIONS_TABLE,
          rows: String(readMigrationFiles({ migrationsFolder: chains[1] }).length),
        },
      ]);
      const bm25 = await admin.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexdef ILIKE '%USING bm25%'`,
        [names.schemaName],
      );
      expect(bm25.rows.length).toBeGreaterThan(0);

      // A second run finds nothing to apply.
      await oss.run(owner, { schemaName: names.schemaName, tenantId });
      const rerun = await admin.query(
        `SELECT count(*)::int AS n FROM "${names.schemaName}"."${TENANT_MIGRATIONS_TABLE}"`,
      );
      expect(rerun.rows[0].n).toBe(readMigrationFiles({ migrationsFolder }).length);
    } finally {
      await owner.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      await root.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await root.query(`DROP ROLE IF EXISTS "${names.ownerUsername}"`).catch(() => undefined);
      await root.end();
    }
  }, 120_000);
});
