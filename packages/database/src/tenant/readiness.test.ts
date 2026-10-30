// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TENANT_MIGRATIONS_TABLE } from './migrator';
import { tenantDbNames } from './names';
import { verifyTenantRuntime } from './readiness';

const TENANT_ID = '0b5f7a52-9c43-4c39-8f0e-0d1c2b3a4f5e';
const { ownerUsername, runtimeUsername, schemaName } = tenantDbNames(TENANT_ID);
const context = { schemaName, tenantId: TENANT_ID };
const migrators = [{ journalTables: [TENANT_MIGRATIONS_TABLE], name: 'lobehub' }] as never;

/** A real catalog: an owner-owned tenant schema the runtime role may only use. */
describe('verifyTenantRuntime', () => {
  let db: PGlite;
  const client = {
    query: async (text: string, params?: unknown[]) => {
      const result = await db.query(text, params);
      return { rowCount: result.rows.length, rows: result.rows };
    },
  } as never;
  const verify = () => verifyTenantRuntime(client, context, migrators);

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      CREATE ROLE "${ownerUsername}" NOLOGIN;
      CREATE ROLE "${runtimeUsername}" NOLOGIN;
      CREATE SCHEMA "${schemaName}" AUTHORIZATION "${ownerUsername}";
      GRANT USAGE ON SCHEMA "${schemaName}" TO "${runtimeUsername}";
    `);
  });
  afterEach(async () => {
    await db.close();
  });

  const asRuntime = () => db.exec(`SET ROLE "${runtimeUsername}"`);

  it('admits the runtime role on a schema whatever its migration state', async () => {
    await asRuntime();
    await expect(verify()).resolves.toBeUndefined();
  });

  it.each(['SUPERUSER', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB'])(
    'refuses a runtime role with %s',
    async (attribute) => {
      await db.exec(`ALTER ROLE "${runtimeUsername}" ${attribute}`);
      await asRuntime();
      await expect(verify()).rejects.toThrow('RUNTIME_ROLE_INVALID');
    },
  );

  it('refuses a runtime role that can assume the schema owner', async () => {
    await db.exec(`GRANT "${ownerUsername}" TO "${runtimeUsername}"`);
    await asRuntime();
    await expect(verify()).rejects.toThrow('RUNTIME_ROLE_INVALID');
  });

  it('refuses any connection other than the tenant runtime role', async () => {
    await expect(verify()).rejects.toThrow('RUNTIME_ROLE_INVALID');
  });

  it('refuses a privileged schema owner', async () => {
    await db.exec(`ALTER ROLE "${ownerUsername}" BYPASSRLS`);
    await asRuntime();
    await expect(verify()).rejects.toThrow('OWNER_PRIVILEGED');
  });

  it('refuses a runtime role that may write an existing migration journal', async () => {
    await db.exec(`
      CREATE TABLE "${schemaName}"."${TENANT_MIGRATIONS_TABLE}" (id serial PRIMARY KEY, hash text);
      ALTER TABLE "${schemaName}"."${TENANT_MIGRATIONS_TABLE}" OWNER TO "${ownerUsername}";
      GRANT SELECT, UPDATE ON "${schemaName}"."${TENANT_MIGRATIONS_TABLE}" TO "${runtimeUsername}";
    `);
    await asRuntime();
    await expect(verify()).rejects.toThrow('MIGRATION_JOURNAL_ACCESS_INVALID');
  });

  it('refuses access to another schema', async () => {
    await db.exec(`GRANT USAGE ON SCHEMA public TO "${runtimeUsername}"`);
    await asRuntime();
    await expect(verify()).rejects.toThrow('CROSS_SCHEMA_USAGE');
  });
});
