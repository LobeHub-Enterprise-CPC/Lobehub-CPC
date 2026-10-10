// @vitest-environment node
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { runTenantMigrations, TENANT_ONLY_MIGRATIONS_TABLE } from '../migrator';
import { tenantDbNames } from '../names';

const folder = path.join(__dirname, '../../../migrations/tenant');
const tenantId = 'sso-jsonb-migration';
const { schemaName, ownerUsername } = tenantDbNames(tenantId);
const journal = `"${schemaName}"."${TENANT_ONLY_MIGRATIONS_TABLE}"`;
const table = `"${schemaName}".sso_providers`;

const setup = async (legacyConfig: string | null) => {
  const db = new PGlite();
  await db.exec(
    `CREATE ROLE "${ownerUsername}"; CREATE SCHEMA "${schemaName}" AUTHORIZATION "${ownerUsername}"; SET ROLE "${ownerUsername}"; SET search_path TO "${schemaName}"`,
  );
  const [initial] = readMigrationFiles({ migrationsFolder: folder });
  for (const statement of initial.sql) await db.exec(statement);
  await db.exec(
    `CREATE TABLE ${journal} (id serial primary key, hash text not null, created_at bigint)`,
  );
  await db.query(`INSERT INTO ${journal} (hash,created_at) VALUES ($1,$2)`, [
    initial.hash,
    initial.folderMillis,
  ]);
  await db.query(
    `INSERT INTO ${table} (id,provider_id,display_name,issuer,protocol,oidc_config,secret_config_encrypted) VALUES ('legacy','legacy','Legacy','https://idp.example','oidc',$1,'unchanged-ciphertext')`,
    [legacyConfig],
  );
  return db;
};

const migrate = (db: PGlite) =>
  runTenantMigrations(db as unknown as Client, folder, {
    schemaName,
    tenantId,
    migrationsTable: TENANT_ONLY_MIGRATIONS_TABLE,
  });

describe('SSO JSONB migration', () => {
  it('preserves historical objects, SQL NULL, ciphertext and the journal prefix across repeated runs', async () => {
    const config = { clientId: 'legacy-client', scopes: ['openid'], nested: { preserved: true } };
    const db = await setup(JSON.stringify(config));
    try {
      const before = await db.query(`SELECT * FROM ${journal} ORDER BY id`);
      await migrate(db);
      const after = await db.query(`SELECT * FROM ${journal} ORDER BY id`);
      expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
      expect(
        (
          await db.query(
            `SELECT oidc_config,oauth2_config,saml_config,secret_config_encrypted FROM ${table}`,
          )
        ).rows,
      ).toEqual([
        {
          oidc_config: config,
          oauth2_config: null,
          saml_config: null,
          secret_config_encrypted: 'unchanged-ciphertext',
        },
      ]);
      expect(
        (await db.query(`SELECT pg_typeof(oidc_config)::text AS type FROM ${table}`)).rows,
      ).toEqual([{ type: 'jsonb' }]);
      await expect(migrate(db)).resolves.toBe(0);
      expect((await db.query(`SELECT * FROM ${journal} ORDER BY id`)).rows).toEqual(after.rows);
      await expect(db.query(`UPDATE ${table} SET oauth2_config = '[]'::jsonb`)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it.each(['invalid json', '[]', 'null', '42'])(
    'rejects legacy %s without changing data, column types or history',
    async (config) => {
      const db = await setup(config);
      try {
        const before = await db.query(`SELECT * FROM ${journal} ORDER BY id`);
        await expect(migrate(db)).rejects.toMatchObject({ reason: 'migration-failed' });
        expect(
          (await db.query(`SELECT oidc_config,pg_typeof(oidc_config)::text AS type FROM ${table}`))
            .rows,
        ).toEqual([{ oidc_config: config, type: 'text' }]);
        expect((await db.query(`SELECT * FROM ${journal} ORDER BY id`)).rows).toEqual(before.rows);
      } finally {
        await db.close();
      }
    },
  );
});
