import { describe, expect, it } from 'vitest';

import { assertTenantMigrationStatementSafe } from './migrationSafety';

describe('tenant migration execution boundary', () => {
  it.each([
    'DO $$ BEGIN CREATE EXTENSION pg_search; END $$',
    'CREATE SCHEMA other',
    'ALTER EXTENSION vector SET SCHEMA other',
    'DROP SCHEMA other',
    'ALTER DATABASE app SET search_path TO public',
    'SET search_path TO other',
    'SET LOCAL ROLE other',
    'SET SESSION AUTHORIZATION other',
    "SELECT set_config('search_path', 'other', true)",
    'ALTER TABLE users SET SCHEMA other',
    'SELECT * FROM "public".users',
    'SELECT * FROM public.users',
    'DO $$ BEGIN CREATE /* c */ EXTENSION IF NOT EXISTS pg_search; END $$;',
    'DO $body$ BEGIN CREATE -- c\nEXTENSION pg_search; END $body$;',
    'DO $body$ BEGIN CREATE -- c\rEXTENSION pg_search; END $body$;',
    'DO $$ BEGIN EXECUTE $sql$CREATE /* c */ EXTENSION pg_search$sql$; END $$;',
    'SET /* nested /* c */ comment */ LOCAL -- c\nROLE other',
    'SELECT * FROM public /* c */ . users',
    "SELECT set_config(/* c */'search_path', 'other', true)",
    'CREATE INDEX CONCURRENTLY idx_a ON users (name)',
    'create unique index concurrently if not exists idx_a on users (name)',
    'DROP INDEX CONCURRENTLY idx_a',
    'REINDEX INDEX CONCURRENTLY idx_a',
    'REINDEX (VERBOSE, CONCURRENTLY) TABLE users',
    'CREATE INDEX /* c */ CONCURRENTLY idx_a ON users (name)',
  ])('refuses %s', (statement) => {
    expect(() => assertTenantMigrationStatementSafe(statement)).toThrow(
      expect.objectContaining({ code: 'TENANT_NOT_READY', reason: 'migration-failed' }),
    );
  });

  it.each([
    "SELECT 'unterminated",
    'SELECT "unterminated',
    'SELECT 1 /* unterminated',
    'DO $body$ BEGIN NULL;',
    'DO $体$ BEGIN NULL;',
    "DO $$ BEGIN RAISE NOTICE 'unterminated; END $$",
  ])('refuses lexically incomplete SQL: %s', (statement) => {
    expect(() => assertTenantMigrationStatementSafe(statement)).toThrow(
      expect.objectContaining({ code: 'TENANT_NOT_READY', reason: 'migration-failed' }),
    );
  });

  it('preserves comment markers and escaped delimiters inside quoted values', () => {
    expect(() =>
      assertTenantMigrationStatementSafe(
        `DO $body$ BEGIN RAISE NOTICE 'it''s /* literal -- */ $$'; END $body$;
       SELECT "a--b/*c*/", E'quote\\'--literal';`,
      ),
    ).not.toThrow();
  });

  it('conservatively refuses forbidden words even inside a string literal', () => {
    expect(() => assertTenantMigrationStatementSafe("SELECT 'CREATE EXTENSION pg_search'")).toThrow(
      expect.objectContaining({ code: 'TENANT_NOT_READY', reason: 'migration-failed' }),
    );
  });

  it('ignores CONCURRENTLY in comments and data literals', () => {
    expect(() =>
      assertTenantMigrationStatementSafe(
        `-- CREATE INDEX CONCURRENTLY idx_a ON users (name)
        /* DROP INDEX CONCURRENTLY idx_a */
        INSERT INTO notes (body) VALUES ('REINDEX TABLE CONCURRENTLY users')`,
      ),
    ).not.toThrow();
  });

  it('allows ordinary tenant DDL and read-only extension checks', () => {
    expect(() =>
      assertTenantMigrationStatementSafe(
        'ALTER TABLE users ADD COLUMN label text; SELECT 1 FROM pg_extension',
      ),
    ).not.toThrow();
  });
});
