// @vitest-environment node
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, vi } from 'vitest';

import { installFtsSearchSyncCapture } from '../../../../../../scripts/installFtsSearchSyncCapture';
import { materializeTenantMigrations } from '../../../tenant/migrator';
import captureHistory from '../captureHistory.json';
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
  it('repairs missing and historical capture, validates current capture without DDL, and refuses tampering', async () => {
    const pglite = await tenantDatabase();
    const repository = new FtsSearchSyncOutboxRepository(
      drizzle({ client: pglite }) as unknown as ConstructorParameters<
        typeof FtsSearchSyncOutboxRepository
      >[0],
    );
    const install = () =>
      installFtsSearchSyncCapture({
        env: { DATABASE_URL: 'postgres://unused' },
        listTenants: async () => [
          { tenantId: SCHEMA, open: async () => ({ repository, close: async () => {} }) },
        ],
      });
    try {
      await install();
      await repository.assertCaptureInfrastructure();
      const mutation = vi.spyOn(repository, 'installCaptureInfrastructure');
      await install();
      expect(mutation).not.toHaveBeenCalled();
      mutation.mockRestore();

      const historical = captureHistory.find(({ version }) => version === 1)!;
      for (const fn of historical.functions)
        await pglite.exec(`DROP FUNCTION ${fn.name}(${fn.identityArguments}) CASCADE`);
      await pglite.exec('DELETE FROM fts_search_sync_capture_version');
      for (const fn of historical.functions)
        await pglite.exec(
          `CREATE FUNCTION ${fn.name}(${fn.identityArguments}) RETURNS ${fn.result} AS $capture$ ${fn.body} $capture$ LANGUAGE plpgsql`,
        );
      for (const trigger of historical.triggers)
        await pglite.exec(trigger.definition.replace(/ ON public\./, ` ON ${SCHEMA}.`));
      await pglite.exec("INSERT INTO fts_search_sync_capture_version VALUES ('capture', 1)");
      await install();
      await repository.assertCaptureInfrastructure();

      await pglite.exec(
        'CREATE OR REPLACE FUNCTION capture_fts_search_sync_change() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql',
      );
      await expect(install()).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining('Refusing to replace partial or unknown'),
        }),
      });
      expect(
        (
          await pglite.query<{ prosrc: string }>(
            "SELECT prosrc FROM pg_proc WHERE proname = 'capture_fts_search_sync_change' AND pronamespace = current_schema()::regnamespace",
          )
        ).rows[0].prosrc,
      ).toContain('RETURN NULL');
    } finally {
      vi.restoreAllMocks();
      await pglite.close();
    }
  }, 120_000);

  it('installs, verifies and captures inside the tenant schema only', async () => {
    const pglite = await tenantDatabase();
    const repository = new FtsSearchSyncOutboxRepository(drizzle({ client: pglite }) as never);

    // Provisioning migrates the schema but installs no capture: name that, not a version mismatch.
    await expect(repository.assertCaptureInfrastructure()).rejects.toThrow(
      'FTS search sync capture infrastructure is not installed',
    );
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
