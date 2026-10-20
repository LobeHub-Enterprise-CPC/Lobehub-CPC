// @vitest-environment node
/**
 * The shared migration chain (`packages/database/migrations`, written for
 * `public`) is replayed in every tenant schema. These tests keep every
 * migration, including ones canary adds later, inside the tenant schema:
 * a new migration that creates or touches an object elsewhere fails here.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { TenantDatabaseError } from '../errors';
import {
  assertTenantMigrationSources,
  getTenantMigrators,
  materializeTenantMigrations,
  materializeTenantStatement,
  resolveTenantMigrationsFolder,
  runTenantMigrations,
  TENANT_MIGRATIONS_TABLE,
  TENANT_ONLY_MIGRATIONS_TABLE,
  verifyTenantMigrationHistory,
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
  it('preserves data literals and comments containing schema-like text', () => {
    const statement = `UPDATE public.users SET name = 'hello public.Foo', avatar = '"public".photo' -- public.comment
WHERE name = 'public.users';`;
    expect(materializeTenantStatement(statement, SCHEMA))
      .toBe(`UPDATE "${SCHEMA}".users SET name = 'hello public.Foo', avatar = '"public".photo' -- public.comment
WHERE name = 'public.users';`);
  });

  it('preserves dollar-quoted data and rewrites SQL inside DO bodies', () => {
    expect(
      materializeTenantStatement(
        'INSERT INTO public.users (name) VALUES ($data$public.Foo$data$)',
        SCHEMA,
      ),
    ).toBe(`INSERT INTO "${SCHEMA}".users (name) VALUES ($data$public.Foo$data$)`);
    expect(
      materializeTenantStatement(
        'DO $$ BEGIN ALTER TABLE public.users ADD COLUMN x text; END $$',
        SCHEMA,
      ),
    ).toBe(`DO $$ BEGIN ALTER TABLE "${SCHEMA}".users ADD COLUMN x text; END $$`);
  });

  it('rewrites a bulk data migration in linear time', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `('row ${i} public.x')`).join(',');
    const started = performance.now();
    const rewritten = materializeTenantStatement(`INSERT INTO public.t (v) VALUES ${rows}`, SCHEMA);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(rewritten.startsWith(`INSERT INTO "${SCHEMA}".t (v) VALUES ('row 0 public.x')`)).toBe(
      true,
    );
    expect(rewritten.endsWith("('row 19999 public.x')")).toBe(true);
  });

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

describe('a chain authored against a declared placeholder schema', () => {
  const PLACEHOLDER = 'tenant_template';
  const rewrite = (statement: string) => materializeTenantStatement(statement, SCHEMA, PLACEHOLDER);

  it('applies the public rules to the placeholder instead of public', () => {
    expect(
      rewrite(
        `CREATE TABLE "${PLACEHOLDER}"."a" ("id" text);\n-- "${PLACEHOLDER}"."comment"\nALTER TABLE ${PLACEHOLDER}.a ADD COLUMN note text DEFAULT 'tenant_template.x';`,
      ),
    ).toBe(
      `CREATE TABLE "${SCHEMA}"."a" ("id" text);\n-- "${PLACEHOLDER}"."comment"\nALTER TABLE "${SCHEMA}".a ADD COLUMN note text DEFAULT 'tenant_template.x';`,
    );
    expect(rewrite(`SELECT to_regclass('"${PLACEHOLDER}".a'), '${PLACEHOLDER}.b'::regclass`)).toBe(
      `SELECT to_regclass('"${SCHEMA}".a'), '"${SCHEMA}".b'::regclass`,
    );
  });

  it('turns the quoted placeholder literal into the schema name in any context', () => {
    expect(
      rewrite(
        `DO $h$ BEGIN PERFORM to_regclass(format('%I.%I', 'tenant_template', 'a')); RAISE NOTICE 'tenant_template.x'; END $h$`,
      ),
    ).toBe(
      `DO $h$ BEGIN PERFORM to_regclass(format('%I.%I', '${SCHEMA}', 'a')); RAISE NOTICE 'tenant_template.x'; END $h$`,
    );
  });

  it('keeps the same extension, pg_search and transaction rules', () => {
    expect(rewrite('BEGIN;')).toBeNull();
    expect(rewrite('CREATE EXTENSION IF NOT EXISTS vector;')).toContain("extname = 'vector'");
    expect(rewrite('CREATE EXTENSION IF NOT EXISTS vector;')).not.toMatch(/create extension/i);
  });

  it('leaves public alone: a public qualifier in a placeholder chain is rejected, not rewritten', () => {
    const chain = (sql: string) => [{ bps: true, folderMillis: 1, hash: 'h', sql: [sql] }];
    expect(() =>
      materializeTenantMigrations(
        chain('CREATE TABLE "public"."a" (id text)'),
        SCHEMA,
        PLACEHOLDER,
      ),
    ).toThrow(TenantDatabaseError);
    expect(() =>
      materializeTenantMigrations(chain('DROP TABLE public.a'), SCHEMA, PLACEHOLDER),
    ).toThrow(TenantDatabaseError);
  });

  it('rejects unsafe statements before returning anything', () => {
    const unsafe = [
      `CREATE SCHEMA "${PLACEHOLDER}"`,
      `SET search_path TO "${PLACEHOLDER}"`,
      `DROP SCHEMA "${PLACEHOLDER}" CASCADE`,
    ];
    for (const statement of unsafe)
      expect(
        () =>
          materializeTenantMigrations(
            [{ bps: true, folderMillis: 1, hash: 'h', sql: [statement] }],
            SCHEMA,
            PLACEHOLDER,
          ),
        statement,
      ).toThrow(TenantDatabaseError);
  });

  it('refuses a placeholder that survives the rewrite as a bare identifier', () => {
    expect(() =>
      materializeTenantMigrations(
        [
          {
            bps: true,
            folderMillis: 1,
            hash: 'h',
            sql: [`ALTER TABLE "a" SET SCHEMA "${PLACEHOLDER}"`],
          },
        ],
        SCHEMA,
        PLACEHOLDER,
      ),
    ).toThrow(TenantDatabaseError);
  });

  it('keeps hashes and timestamps and does not mutate its input', () => {
    const source = [
      {
        bps: true,
        folderMillis: 7,
        hash: 'abc',
        sql: [`CREATE TABLE "${PLACEHOLDER}"."a" (id text)`],
      },
    ];
    const [result] = materializeTenantMigrations(source, SCHEMA, PLACEHOLDER);
    expect(result).toMatchObject({ folderMillis: 7, hash: 'abc' });
    expect(result.sql).toEqual([`CREATE TABLE "${SCHEMA}"."a" (id text)`]);
    expect(source[0].sql).toEqual([`CREATE TABLE "${PLACEHOLDER}"."a" (id text)`]);
  });

  it('only accepts a plain identifier that is not itself a tenant schema', () => {
    for (const source of ['Bad-Name', 'a"b', 'tenant_fedcba9876543210fedcba98', ''])
      expect(() => materializeTenantMigrations([], SCHEMA, source), source).toThrow(
        TenantDatabaseError,
      );
  });

  it('is the identity change for the default: public chains behave as before', () => {
    const statement =
      'ALTER TABLE "t" ADD CONSTRAINT "f" FOREIGN KEY ("u") REFERENCES "public"."users"("id")';
    expect(materializeTenantStatement(statement, SCHEMA)).toBe(
      materializeTenantStatement(statement, SCHEMA, 'public'),
    );
    expect(rewrite(statement)).toBe(statement);
  });
});

describe('the shared and tenant-only chains', () => {
  it.each(['fresh', 'existing-oidc-prefix', 'governance-channel-tables-created-outside'])(
    'runs both chains and reruns without changes for %s',
    async (installation) => {
      const tenantId = `tenant-chain-${installation}`;
      const { schemaName, ownerUsername } = tenantDbNames(tenantId);
      const db = new PGlite({ extensions: { vector } });
      const client = db as unknown as Client;
      const options = { schemaName, tenantId };
      const tenantOptions = { ...options, migrationsTable: TENANT_ONLY_MIGRATIONS_TABLE };
      const shared = readMigrationFiles({ migrationsFolder });
      const tenant = readMigrationFiles({ migrationsFolder: chains[1] });
      const journal = `"${schemaName}"."${TENANT_ONLY_MIGRATIONS_TABLE}"`;
      try {
        await db.exec(`CREATE SCHEMA extensions; CREATE EXTENSION vector WITH SCHEMA extensions;
          CREATE ROLE "${ownerUsername}";
          CREATE SCHEMA "${schemaName}" AUTHORIZATION "${ownerUsername}";
          GRANT USAGE ON SCHEMA extensions TO "${ownerUsername}";
          SET ROLE "${ownerUsername}"`);
        expect(await runTenantMigrations(client, migrationsFolder, options)).toBe(shared.length);

        if (installation !== 'fresh') {
          // Replay the immutable pre-retirement prefix and its persisted identities.
          await db.exec(`BEGIN; SET LOCAL search_path TO "${schemaName}", extensions;
            CREATE TABLE ${journal} (id serial primary key, hash text not null, created_at bigint)`);
          for (const migration of materializeTenantMigrations(tenant.slice(0, 2), schemaName)) {
            for (const statement of migration.sql) await db.exec(statement);
            await db.query(`INSERT INTO ${journal} (hash, created_at) VALUES ($1, $2)`, [
              migration.hash,
              migration.folderMillis,
            ]);
          }
          await db.exec('COMMIT');
        }
        if (installation === 'governance-channel-tables-created-outside') {
          // What an installation that ran a distribution chain holds before this chain owns the tables:
          // the tables exist, the journal entry of their migration does not.
          const creating = tenant.findIndex((migration) =>
            migration.sql.some((statement) => statement.includes('"channel_approvals"')),
          );
          await db.exec(`SET search_path TO "${schemaName}", extensions`);
          for (const migration of materializeTenantMigrations(
            tenant.slice(creating, creating + 1),
            schemaName,
          ))
            for (const statement of migration.sql) await db.exec(statement);
        }

        expect(await runTenantMigrations(client, chains[1], tenantOptions)).toBe(
          tenant.length - (installation === 'fresh' ? 0 : 2),
        );
        const before = await db.query(`SELECT * FROM ${journal} ORDER BY id`);
        expect(await runTenantMigrations(client, migrationsFolder, options)).toBe(0);
        expect(await runTenantMigrations(client, chains[1], tenantOptions)).toBe(0);
        expect(await db.query(`SELECT * FROM ${journal} ORDER BY id`)).toEqual(before);
        expect(await verifyTenantMigrationHistory(client, chains[1], tenantOptions)).toBe(
          tenant.length,
        );

        // Readiness covers the governance and Channel tables, whoever created them.
        const [lobehub] = getTenantMigrators();
        const context = { schemaName, tenantId };
        await lobehub.verify(client, context);
        await db.exec(
          `ALTER TABLE "${schemaName}"."command_governance_rules" DROP COLUMN "pattern"`,
        );
        await expect(lobehub.verify(client, context)).rejects.toMatchObject({
          reason: 'schema-not-provisioned',
        });
      } finally {
        await db.close();
      }
    },
    30_000,
  );

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
      [SCHEMA, ['users', 'messages', 'sso_providers']],
    );
    expect(rows.map((row) => row.name).sort()).toEqual(['messages', 'sso_providers', 'users']);
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

      await oss.verify(owner, { schemaName: names.schemaName, tenantId });

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

describe('migration history verification', () => {
  it('accepts the tenant-only prefix already applied before SSO retirement', async () => {
    const db = new PGlite();
    const [baseline] = readMigrationFiles({ migrationsFolder: chains[1] });
    try {
      await db.exec(
        `CREATE SCHEMA "${SCHEMA}"; CREATE TABLE "${SCHEMA}"."${TENANT_ONLY_MIGRATIONS_TABLE}" (id serial primary key, hash text not null, created_at bigint)`,
      );
      for (const [hash, when] of [
        [baseline.hash, baseline.folderMillis],
        ['695c0b02bb5e6334ce62cf9e7115f7e25ab0bd0b54def189b6b3eed5de39e882', 1791947960048],
      ])
        await db.query(
          `INSERT INTO "${SCHEMA}"."${TENANT_ONLY_MIGRATIONS_TABLE}" (hash, created_at) VALUES ($1, $2)`,
          [hash, when],
        );
      await expect(
        verifyTenantMigrationHistory(db as unknown as Client, chains[1], {
          schemaName: SCHEMA,
          migrationsTable: TENANT_ONLY_MIGRATIONS_TABLE,
          allowPending: true,
        }),
      ).resolves.toBe(2);
    } finally {
      await db.close();
    }
  });

  it.each(['changed-hash', 'future-time', 'null-time', 'missing-prefix', 'duplicate', 'reordered'])(
    'rejects %s without altering the journal',
    async (mutation) => {
      const db = new PGlite();
      const migrations = readMigrationFiles({ migrationsFolder });
      await db.exec(
        `CREATE SCHEMA "${SCHEMA}"; CREATE TABLE "${SCHEMA}".__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
      );
      for (const migration of migrations.slice(0, 2))
        await db.query(
          `INSERT INTO "${SCHEMA}".__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
      const statements: Record<string, string> = {
        'changed-hash': `UPDATE "${SCHEMA}".__drizzle_migrations SET hash = 'old-draft' WHERE id = 1`,
        'future-time': `UPDATE "${SCHEMA}".__drizzle_migrations SET created_at = 9007199254740993 WHERE id = 2`,
        'null-time': `UPDATE "${SCHEMA}".__drizzle_migrations SET created_at = NULL WHERE id = 1`,
        'missing-prefix': `DELETE FROM "${SCHEMA}".__drizzle_migrations WHERE id = 1`,
        'duplicate': `INSERT INTO "${SCHEMA}".__drizzle_migrations (hash, created_at) SELECT hash, created_at FROM "${SCHEMA}".__drizzle_migrations WHERE id = 2`,
        'reordered': `UPDATE "${SCHEMA}".__drizzle_migrations SET id = -id`,
      };
      await db.exec(statements[mutation]);
      const before = await db.query(`SELECT * FROM "${SCHEMA}".__drizzle_migrations ORDER BY id`);
      try {
        // PGlite executes the same PostgreSQL catalog and journal queries.
        await expect(
          verifyTenantMigrationHistory(db as unknown as Client, migrationsFolder, {
            schemaName: SCHEMA,
            allowPending: true,
          }),
        ).rejects.toMatchObject({ reason: 'migration-history-mismatch' });
        expect(
          await db.query(`SELECT * FROM "${SCHEMA}".__drizzle_migrations ORDER BY id`),
        ).toEqual(before);
      } finally {
        await db.close();
      }
    },
  );

  it('accepts a valid pending prefix for migration, but not for readiness', async () => {
    const db = new PGlite();
    const [first] = readMigrationFiles({ migrationsFolder });
    await db.exec(
      `CREATE SCHEMA "${SCHEMA}"; CREATE TABLE "${SCHEMA}".__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
    );
    await db.query(
      `INSERT INTO "${SCHEMA}".__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [first.hash, first.folderMillis],
    );
    try {
      await expect(
        verifyTenantMigrationHistory(db as unknown as Client, migrationsFolder, {
          schemaName: SCHEMA,
          allowPending: true,
        }),
      ).resolves.toBe(1);
      await expect(
        verifyTenantMigrationHistory(db as unknown as Client, migrationsFolder, {
          schemaName: SCHEMA,
        }),
      ).rejects.toMatchObject({ reason: 'migration-history-mismatch' });
    } finally {
      await db.close();
    }
  });
});

describe('tenant migration sources', () => {
  /** A working directory laid out like the worker image: `<cwd>/migrations`. */
  const imageLayout = (withChains: boolean) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'tenant-migration-sources-'));
    if (withChains) symlinkSync(migrationsFolder, path.join(cwd, 'migrations'), 'dir');
    return cwd;
  };

  it('resolves the shared and tenant-only chains from <cwd>/migrations', () => {
    const cwd = imageLayout(true);
    try {
      expect(resolveTenantMigrationsFolder(cwd)).toBe(path.join(cwd, 'migrations'));
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it('accepts a layout where every registered chain can be read', () => {
    const cwd = imageLayout(true);
    try {
      expect(() => assertTenantMigrationSources(cwd)).not.toThrow();
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it('refuses a layout without the OSS chains, as every tenant entry would', () => {
    const cwd = imageLayout(false);
    try {
      expect(() => assertTenantMigrationSources(cwd)).toThrow(
        expect.objectContaining({ code: 'TENANT_NOT_READY', reason: 'migration-failed' }),
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it('asks every registered chain, so a distribution chain cannot go missing', () => {
    const cwd = imageLayout(true);
    try {
      const missing = new Error('Enterprise tenant migrations folder not found');
      const chain = {
        assertSources: (received: string) => {
          expect(received).toBe(cwd);
          throw missing;
        },
        journalTables: [],
        name: 'distribution',
        run: async () => {},
        verify: async () => {},
      };
      expect(() => assertTenantMigrationSources(cwd, [...getTenantMigrators(), chain])).toThrow(
        missing,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
