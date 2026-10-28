// @vitest-environment node
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

import { materializeTenantMigrations } from '../migrator';

const SCHEMA = 'tenant_0123456789abcdef01234567';
const tenantFolder = path.join(__dirname, '../../../migrations/tenant');

const chain = () =>
  materializeTenantMigrations(readMigrationFiles({ migrationsFolder: tenantFolder }), SCHEMA);

const apply = async (db: PGlite, migrations: ReturnType<typeof chain>) => {
  for (const migration of migrations)
    for (const statement of migration.sql) await db.exec(statement);
};

const createDatabase = async () => {
  const db = new PGlite({ extensions: { vector } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
  await db.exec(`CREATE SCHEMA "${SCHEMA}"; SET search_path TO "${SCHEMA}", public`);
  // Tenant-only OIDC changes depend on the application tables from the shared chain.
  const shared = materializeTenantMigrations(
    readMigrationFiles({ migrationsFolder: path.dirname(tenantFolder) }),
    SCHEMA,
  );
  for (const migration of shared)
    for (const statement of migration.sql)
      if (!/pg_search|bm25/i.test(statement)) await db.exec(statement);
  return db;
};

const insert = (
  db: PGlite,
  id: string,
  protocol: string,
  config: { column: string; value: unknown } | null,
) =>
  db.query(
    `INSERT INTO "sso_providers" ("id", "provider_id", "display_name", "issuer", "protocol", "revision"${
      config ? `, "${config.column}"` : ''
    }) VALUES ($1, $1, $1, 'https://idp', $2, 7${config ? ', $3::jsonb' : ''})`,
    config ? [id, protocol, JSON.stringify(config.value)] : [id, protocol],
  );

describe('SAML and named OAuth2 preset retirement (tenant chain)', () => {
  it('soft-deletes retired providers, keeps supported ones, and drops saml_config', async () => {
    const db = await createDatabase();
    const migrations = chain();
    expect(migrations.length).toBeGreaterThanOrEqual(3);

    // The state an installation had before the retirement: the baseline table only.
    await apply(db, migrations.slice(0, 1));
    await insert(db, 'saml', 'saml', { column: 'saml_config', value: { cert: 'c' } });
    await insert(db, 'github', 'oauth2', { column: 'oauth2_config', value: { preset: 'github' } });
    await insert(db, 'wecom', 'oauth2', { column: 'oauth2_config', value: { preset: 'wecom' } });
    await insert(db, 'no-preset', 'oauth2', { column: 'oauth2_config', value: { clientId: 'x' } });
    await insert(db, 'custom', 'oauth2', { column: 'oauth2_config', value: { preset: 'custom' } });
    await insert(db, 'oidc', 'oidc', { column: 'oidc_config', value: { clientId: 'x' } });
    await insert(db, 'bridge', 'bridge', null);
    await db.query(
      `UPDATE "sso_providers" SET "deleted_at" = '2026-01-01T00:00:00Z' WHERE "id" = 'saml'`,
    );

    await apply(db, migrations.slice(1));

    const { rows } = await db.query<{
      id: string;
      enabled: boolean;
      deleted: boolean;
      revision: number;
    }>(
      `SELECT "id", "enabled", "deleted_at" IS NOT NULL AS deleted, "revision" FROM "sso_providers" ORDER BY "id"`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, [row.enabled, row.deleted]]))).toEqual({
      'bridge': [true, false],
      'custom': [true, false],
      'github': [false, true],
      'no-preset': [false, true],
      'oidc': [true, false],
      'saml': [true, true], // already deleted before: untouched (enabled stays as it was)
      'wecom': [false, true],
    });
    // The revision is part of the secret AAD and must not move.
    expect(rows.every((row) => row.revision === 7)).toBe(true);

    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sso_providers'`,
      [SCHEMA],
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('saml_config');
    const checks = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${SCHEMA}"."sso_providers"'::regclass`,
    );
    expect(checks.rows.map((row) => row.conname)).not.toContain('sso_providers_saml_config_object');
    await db.close();
  });

  it('installs from an empty schema', async () => {
    const db = await createDatabase();
    await apply(db, chain());
    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "sso_providers"`,
    );
    expect(rows[0].count).toBe(0);
    await db.close();
  });
});
