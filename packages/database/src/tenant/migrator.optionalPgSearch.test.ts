// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  assertPgSearchReady,
  PgSearchNotReadyError,
} from '../../../../scripts/migrateServerDB/pgSearchGuard';
import {
  materializeTenantMigrations,
  materializeTenantStatement,
  runTenantMigrations,
} from './migrator';
import { tenantDbNames } from './names';

const SCHEMA = 'tenant_0123456789abcdef01234567';
const migrationsFolder = path.join(__dirname, '../../migrations');
let source: string;
beforeAll(async () => {
  source = await readFile(path.join(migrationsFolder, '0090_enable_pg_search.sql'), 'utf8');
});

describe('optional pg_search tenant migration', () => {
  it('adapts the current complete wrapper without changing migration identity', () => {
    const files = readMigrationFiles({ migrationsFolder });
    const adapted = materializeTenantMigrations(files, SCHEMA);
    expect(adapted.map(({ hash, folderMillis }) => [hash, folderMillis])).toEqual(
      files.map(({ hash, folderMillis }) => [hash, folderMillis]),
    );
    const statement = materializeTenantStatement(source, SCHEMA)!;
    expect(statement).not.toMatch(/create\s+extension/i);
    expect(statement).toContain('pg_available_extensions');
    expect(statement).toContain('pg_extension');
  });

  it('skips an unavailable extension without creating anything outside the tenant', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE SCHEMA "${SCHEMA}"; SET search_path TO "${SCHEMA}"`);
      await db.exec(materializeTenantStatement(source, SCHEMA)!);
      expect(
        (await db.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_search'")).rows,
      ).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it.each([
    [
      'changed condition',
      (statement: string) => statement.replace("name = 'pg_search'", "name = 'vector'"),
    ],
    ['extra branch', (statement: string) => statement.replace('END IF;', 'END IF; PERFORM 1;')],
    [
      'block comment',
      (statement: string) => statement.replace('CREATE EXTENSION', 'CREATE /* c */ EXTENSION'),
    ],
    [
      'line comment',
      (statement: string) => statement.replace('CREATE EXTENSION', 'CREATE -- c\nEXTENSION'),
    ],
    [
      'multiline NOTICE injection',
      (statement: string) =>
        statement.replace(
          'pg_search is not available',
          "pg_search\n-- extra'; PERFORM 1; RAISE NOTICE '\nis not available",
        ),
    ],
  ] as const)('rejects %s before sending any SQL to the connection', async (_name, mutate) => {
    const folder = await mkdtemp(path.join(tmpdir(), 'tenant-unsafe-migration-'));
    const query = vi.fn(async () => ({ rows: [] }));
    try {
      await mkdir(path.join(folder, 'meta'));
      await writeFile(path.join(folder, '0000_unsafe.sql'), mutate(source));
      await writeFile(
        path.join(folder, 'meta/_journal.json'),
        JSON.stringify({
          entries: [{ idx: 0, when: 1, tag: '0000_unsafe', breakpoints: true }],
        }),
      );
      await expect(
        runTenantMigrations({ query } as unknown as Client, folder, {
          schemaName: SCHEMA,
          tenantId: 'fixture',
        }),
      ).rejects.toMatchObject({ code: 'TENANT_NOT_READY', reason: 'migration-failed' });
      expect(query).not.toHaveBeenCalled();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('allows only header comments and whitespace outside quoted values to differ', () => {
    const body = source.slice(source.indexOf('DO $$'));
    expect(
      materializeTenantStatement(
        ` \n-- header\n\t${body.replace('BEGIN\n', 'BEGIN   \n\t')}`,
        SCHEMA,
      ),
    ).toBe(materializeTenantStatement(source, SCHEMA));
    const changedLiteral = source.replace('BM25 search setup', 'BM25  search setup');
    expect(materializeTenantStatement(changedLiteral, SCHEMA)).toBe(changedLiteral);
  });

  it('refuses enabling pg_search after skipped migrations even with no pending migrations', async () => {
    const tenantId = 'optional-pgsearch-upgrade';
    const { schemaName, ownerUsername } = tenantDbNames(tenantId);
    const db = new PGlite({ extensions: { vector } });
    try {
      await db.exec(`CREATE SCHEMA extensions; CREATE EXTENSION vector WITH SCHEMA extensions;
        CREATE ROLE "${ownerUsername}";
        CREATE SCHEMA "${schemaName}" AUTHORIZATION "${ownerUsername}";
        GRANT USAGE ON SCHEMA extensions TO "${ownerUsername}";
        SET ROLE "${ownerUsername}"`);
      const client = db as unknown as Client;
      const options = { schemaName, tenantId };
      const files = readMigrationFiles({ migrationsFolder });
      expect(await runTenantMigrations(client, migrationsFolder, options)).toBe(files.length);
      const before = await db.query(
        `SELECT hash, created_at FROM "${schemaName}".__drizzle_migrations ORDER BY id`,
      );
      expect(before.rows).toHaveLength(files.length);
      expect(await runTenantMigrations(client, migrationsFolder, options)).toBe(0);

      // PGlite restricts pg_am more than PostgreSQL; read the final catalog as
      // its fixture administrator while retaining the tenant search_path.
      await db.exec('RESET ROLE');

      // PGlite cannot install pg_search: simulate only that extension's later
      // installation. The applied journal and absent indexes are real catalogs.
      const query = vi.fn(async (text: string) =>
        text.includes('FROM pg_extension')
          ? { rows: [{ '?column?': 1 }] }
          : db.query<Record<string, unknown>>(text),
      );
      await expect(
        assertPgSearchReady(query, { FTS_SEARCH_PROVIDER: 'pg_like' }),
      ).resolves.toBeUndefined();
      expect(query).not.toHaveBeenCalled();
      await db.exec(`SET search_path TO "${schemaName}", extensions`);
      await expect(
        assertPgSearchReady(query, { FTS_SEARCH_PROVIDER: 'pg_search' }),
      ).rejects.toBeInstanceOf(PgSearchNotReadyError);
      expect(query).toHaveBeenCalled();
      expect(
        (
          await db.query(
            `SELECT hash, created_at FROM "${schemaName}".__drizzle_migrations ORDER BY id`,
          )
        ).rows,
      ).toEqual(before.rows);
    } finally {
      await db.close();
    }
  }, 30_000);
});
