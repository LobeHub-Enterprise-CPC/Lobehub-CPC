// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertPgSearchReady,
  PG_SEARCH_BM25_INDEX_NAMES,
  PgSearchNotReadyError,
} from '../../../../../scripts/migrateServerDB/pgSearchGuard';
import { getTenantMigrators, materializeTenantStatement } from '../migrator';
import { tenantDbNames, tenantSearchPathSql } from '../names';

const adminUrl = process.env.TEST_SERVER_DB === '1' ? process.env.DATABASE_TEST_URL : undefined;

describe.skipIf(!adminUrl)('tenant pg_search on isolated PostgreSQL', () => {
  const database = `lh_pgsearch_${process.pid}_${Date.now()}`;
  // a/b build BM25 indexes once pg_search is installed; c migrates while it is only available.
  const tenants = ['a', 'b', 'c'].map((suffix) => {
    const tenantId = `${database}-${suffix}`;
    return { tenantId, ...tenantDbNames(tenantId) };
  });
  const root = new Client({ connectionString: adminUrl });
  const connection = new URL(adminUrl ?? 'postgres://unused');
  connection.pathname = `/${database}`;
  const admin = new Client({ connectionString: connection.toString() });
  const owners = tenants.map(({ ownerUsername }) => {
    const url = new URL(connection);
    url.username = ownerUsername;
    url.password = 'pgsearch-fixture-only';
    return new Client({ connectionString: url.toString() });
  });

  beforeAll(async () => {
    await root.connect();
    await root.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    await admin.connect();
    await admin.query('REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC');
    await admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM PUBLIC`);
    for (const [index, tenant] of tenants.entries()) {
      await admin.query(
        `CREATE ROLE "${tenant.ownerUsername}" LOGIN PASSWORD 'pgsearch-fixture-only'`,
      );
      await admin.query(
        `CREATE SCHEMA "${tenant.schemaName}" AUTHORIZATION "${tenant.ownerUsername}"`,
      );
      await owners[index].connect();
    }
  });

  afterAll(async () => {
    await Promise.all(owners.map((owner) => owner.end()));
    await admin.end();
    await root.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    for (const tenant of tenants) await root.query(`DROP ROLE IF EXISTS "${tenant.ownerUsername}"`);
    await root.end();
  });

  it('migrates without pg_search while it is only available, then builds two independently owned tenant chains', async () => {
    const source = await readFile(
      path.join(__dirname, '../../../migrations/0090_enable_pg_search.sql'),
      'utf8',
    );
    expect(materializeTenantStatement(source, tenants[0].schemaName)).toBeNull();
    expect(
      (await admin.query("SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search'"))
        .rowCount,
    ).toBe(1);

    // Current Ops baseline: vector in its shared schema, pg_search never installed.
    await admin.query('CREATE EXTENSION vector');
    await admin.query('CREATE SCHEMA extensions; ALTER EXTENSION vector SET SCHEMA extensions');
    const [, , withoutPgSearch] = tenants;
    await admin.query(`GRANT USAGE ON SCHEMA extensions TO "${withoutPgSearch.ownerUsername}"`);
    await getTenantMigrators()[0].run(owners[2], withoutPgSearch);
    await getTenantMigrators()[0].verify(owners[2], withoutPgSearch);
    expect(
      (await admin.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_search'")).rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query(
          `SELECT 1 FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
           JOIN pg_am am ON am.oid = i.relam WHERE n.nspname = $1 AND am.amname = 'bm25'`,
          [withoutPgSearch.schemaName],
        )
      ).rowCount,
    ).toBe(0);

    // A database that does install pg_search: 0.25's install SQL references public.vector,
    // so vector is moved back only for that statement, as the old baseline did.
    await admin.query(`ALTER EXTENSION vector SET SCHEMA public; CREATE EXTENSION pg_search;
      ALTER EXTENSION vector SET SCHEMA extensions`);
    const indexed = tenants.slice(0, 2);
    for (const [index, tenant] of indexed.entries()) {
      await admin.query(`GRANT USAGE ON SCHEMA extensions, paradedb TO "${tenant.ownerUsername}"`);
      await getTenantMigrators()[0].run(owners[index], tenant);
      await getTenantMigrators()[0].verify(owners[index], tenant);
      await owners[index].query('BEGIN READ ONLY');
      try {
        await owners[index].query(tenantSearchPathSql(tenant.schemaName));
        await expect(
          assertPgSearchReady((sql: string) => owners[index].query(sql), {
            FTS_SEARCH_PROVIDER: 'pg_search',
          }),
        ).resolves.toBeUndefined();
      } finally {
        await owners[index].query('ROLLBACK');
      }
    }
    const { rows } = await admin.query<{
      index_name: string;
      index_schema: string;
      table_name: string;
      table_schema: string;
      owner_name: string;
      table_owner: string;
      amname: string;
      indisvalid: boolean;
    }>(
      `SELECT i.relname AS index_name, ni.nspname AS index_schema,
       t.relname AS table_name, nt.nspname AS table_schema,
       pg_get_userbyid(i.relowner) AS owner_name, pg_get_userbyid(t.relowner) AS table_owner,
       am.amname, x.indisvalid
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace ni ON ni.oid = i.relnamespace
      JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace nt ON nt.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      WHERE ni.nspname = ANY($1) AND am.amname = 'bm25'
      ORDER BY ni.nspname, i.relname`,
      [indexed.map((tenant) => tenant.schemaName)],
    );
    expect(rows).toHaveLength(2 * PG_SEARCH_BM25_INDEX_NAMES.length);
    for (const tenant of indexed) {
      const indexes = rows.filter((row) => row.index_schema === tenant.schemaName);
      expect(indexes.map((row) => row.index_name).sort()).toEqual(
        [...PG_SEARCH_BM25_INDEX_NAMES].sort(),
      );
      for (const row of indexes) {
        expect(row.table_schema).toBe(tenant.schemaName);
        expect(row.table_name).toBe(row.index_name.replace(/_bm25_idx$/, ''));
        expect(row.owner_name).toBe(tenant.ownerUsername);
        expect(row.table_owner).toBe(tenant.ownerUsername);
        expect(row.indisvalid).toBe(true);
      }
    }
    console.info('tenant BM25 catalog evidence', JSON.stringify(rows));
  }, 120_000);

  it('rejects a same-named BM25 index on the wrong table', async () => {
    const owner = owners[0];
    await owner.query('BEGIN');
    try {
      await owner.query(tenantSearchPathSql(tenants[0].schemaName));
      await owner.query('DROP INDEX messages_bm25_idx');
      await owner.query('CREATE TABLE wrong_target (id text PRIMARY KEY, body text)');
      await owner.query(
        `CREATE INDEX messages_bm25_idx ON wrong_target USING bm25 (id, body) WITH (key_field = 'id')`,
      );
      await expect(
        assertPgSearchReady((sql: string) => owner.query(sql), {
          FTS_SEARCH_PROVIDER: 'pg_search',
        }),
      ).rejects.toBeInstanceOf(PgSearchNotReadyError);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it.each(['other-tenant', 'public'])(
    'rejects a visible same-named index in %s',
    async (fallback) => {
      const owner = owners[0];
      const otherSchema = fallback === 'public' ? 'public' : tenants[1].schemaName;
      if (fallback === 'public') {
        await admin.query(`CREATE TABLE public.messages (id text PRIMARY KEY, body text);
        CREATE INDEX messages_bm25_idx ON public.messages USING bm25 (id, body) WITH (key_field = 'id')`);
      }
      await admin.query(`GRANT USAGE ON SCHEMA "${otherSchema}" TO "${tenants[0].ownerUsername}"`);
      await owner.query('BEGIN');
      try {
        await owner.query(
          `SET LOCAL search_path TO "${tenants[0].schemaName}", "${otherSchema}", extensions, paradedb`,
        );
        await owner.query(
          'DROP INDEX messages_bm25_idx; ALTER TABLE messages RENAME TO hidden_messages',
        );
        await expect(
          assertPgSearchReady((sql: string) => owner.query(sql), {
            FTS_SEARCH_PROVIDER: 'pg_search',
          }),
        ).rejects.toBeInstanceOf(PgSearchNotReadyError);
      } finally {
        await owner.query('ROLLBACK');
        await admin.query(
          `REVOKE USAGE ON SCHEMA "${otherSchema}" FROM "${tenants[0].ownerUsername}"`,
        );
        if (fallback === 'public') await admin.query('DROP TABLE public.messages');
      }
    },
  );

  it('rejects an invalid index', async () => {
    const index = `"${tenants[0].schemaName}".messages_bm25_idx`;
    await admin.query('UPDATE pg_index SET indisvalid = false WHERE indexrelid = $1::regclass', [
      index,
    ]);
    const owner = owners[0];
    await owner.query('BEGIN READ ONLY');
    try {
      await owner.query(tenantSearchPathSql(tenants[0].schemaName));
      await expect(
        assertPgSearchReady((sql: string) => owner.query(sql), {
          FTS_SEARCH_PROVIDER: 'pg_search',
        }),
      ).rejects.toBeInstanceOf(PgSearchNotReadyError);
    } finally {
      await owner.query('ROLLBACK');
      await admin.query('UPDATE pg_index SET indisvalid = true WHERE indexrelid = $1::regclass', [
        index,
      ]);
    }
  });
});
