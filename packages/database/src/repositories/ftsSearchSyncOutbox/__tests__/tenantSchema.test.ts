// @vitest-environment node
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';

import { materializeTenantMigrations } from '../../../tenant/migrator';
import { FtsSearchSyncOutboxRepository } from '../index';

const SCHEMA = 'tenant_0123456789abcdef01234567';
const migrationsFolder = join(__dirname, '../../../../migrations');

/** A tenant schema built by the tenant migrator's rewrite, bound through the search path. */
const tenantDatabase = async () => {
  const pglite = new PGlite({ extensions: { vector } });
  await pglite.exec('CREATE EXTENSION IF NOT EXISTS vector');
  await pglite.exec(`CREATE SCHEMA "${SCHEMA}"`);
  await pglite.exec(`SET search_path TO "${SCHEMA}", public`);
  for (const folder of [migrationsFolder, join(migrationsFolder, 'tenant')])
    for (const migration of materializeTenantMigrations(
      readMigrationFiles({ migrationsFolder: folder }),
      SCHEMA,
    ))
      for (const statement of migration.sql)
        if (!/pg_search|bm25/i.test(statement)) await pglite.exec(statement);
  return pglite;
};

describe('FTS search sync capture in a tenant schema', () => {
  it('installs, verifies and captures inside the tenant schema only', async () => {
    const pglite = await tenantDatabase();
    const repository = new FtsSearchSyncOutboxRepository(drizzle({ client: pglite }) as never);

    await repository.installCaptureInfrastructure();
    // Idempotent: a second deploy only validates the installed definition.
    await repository.installCaptureInfrastructure();
    await expect(repository.assertCaptureInfrastructure()).resolves.toBeUndefined();

    const placement = await pglite.query<{ functions: string; triggers: string }>(
      `SELECT
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE p.proname LIKE '%fts_search_sync%' AND n.nspname <> $1)::text AS functions,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE t.tgname LIKE '%fts_search_sync%' AND n.nspname <> $1)::text AS triggers`,
      [SCHEMA],
    );
    expect(placement.rows[0]).toEqual({ functions: '0', triggers: '0' });

    await pglite.exec(
      `INSERT INTO users (id) VALUES ('user-1');
       INSERT INTO agents (id, user_id, title) VALUES ('agent-1', 'user-1', 'Tenant agent');`,
    );
    const outbox = await pglite.query<{ document_id: string; entity: string }>(
      `SELECT entity, document_id FROM "${SCHEMA}".fts_search_sync_outbox`,
    );
    expect(outbox.rows).toEqual([{ document_id: 'agent-1', entity: 'agents' }]);
    await pglite.close();
  }, 120_000);
});
