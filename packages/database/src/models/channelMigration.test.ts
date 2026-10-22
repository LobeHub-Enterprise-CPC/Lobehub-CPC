// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  channelBaselineMigrationSql,
  channelMigrationSql,
  channelUpgradeMigrationSql,
} from '../../tests/channelMigrations';
import * as privateSchemas from '../privateSchemas';
import type { LobeChatDatabase } from '../type';
import { ChannelModel } from './channel';

// The governance and Channel tables are created by the tenant-only chain's
// 0004_governance_channel_tables.sql and changed by the migrations after it (see
// src/privateSchemas). `public` stands in for the tenant schema, and `users` belongs to the shared
// chain that runs before it. Replays exercise 0004 alone: it is the one written for both starting
// points, and a chain never re-runs it after a later migration.
const open: PGlite[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const createDatabase = async () => {
  const db = new PGlite();
  open.push(db);
  await db.exec("CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner');");
  return db;
};

const modelTables = Object.values(privateSchemas).filter((value) => is(value, PgTable));

describe('governance and Channel migration', () => {
  it('replays idempotently without losing data', async () => {
    const db = await createDatabase();
    await db.exec(channelBaselineMigrationSql());
    await db.exec(`
      INSERT INTO channels (id, owner_id, title) VALUES ('channel', 'owner', 'Preserved');
      INSERT INTO channel_members (id, channel_id, name, config) VALUES ('member', 'channel', 'Agent', '{}');
      INSERT INTO channel_messages
        (id, channel_id, sequence, content, request_key, routing_status)
      VALUES ('message', 'channel', 1, 'Preserve this', 'request', 'assigned');
      INSERT INTO command_governance_rules (user_id, pattern, pattern_type)
      VALUES ('owner', 'rm', 'prefix');
    `);
    await db.exec(channelBaselineMigrationSql());

    expect((await db.query('SELECT title FROM channels')).rows).toEqual([{ title: 'Preserved' }]);
    expect((await db.query('SELECT content FROM channel_messages')).rows).toEqual([
      { content: 'Preserve this' },
    ]);
    expect((await db.query('SELECT pattern FROM command_governance_rules')).rows).toEqual([
      { pattern: 'rm' },
    ]);
  }, 30_000);

  it('creates the tables the models declare, with the same columns', async () => {
    const db = await createDatabase();
    await db.exec(channelMigrationSql());

    const { rows } = await db.query<{ table_name: string; columns: string[] }>(
      `SELECT table_name, array_agg(column_name::text ORDER BY column_name::text) AS columns
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> 'users'
        GROUP BY table_name ORDER BY table_name`,
    );
    const expected = modelTables
      .map((table) => ({
        table_name: getTableName(table),
        columns: Object.values(getTableColumns(table))
          .map((column) => column.name)
          .sort(),
      }))
      .sort((a, b) => a.table_name.localeCompare(b.table_name));
    expect(modelTables).toHaveLength(16);
    expect(rows).toEqual(expected);
  }, 30_000);

  it('creates the final Channel schema, integrity constraints, and runtime indexes', async () => {
    const db = await createDatabase();
    await db.exec(channelMigrationSql());

    const tables = (
      await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'channel%' ORDER BY table_name",
      )
    ).rows.map(({ table_name }) => table_name);
    expect(tables).toEqual([
      'channel_approvals',
      'channel_audit',
      'channel_discussions',
      'channel_jobs',
      'channel_members',
      'channel_messages',
      'channel_outbox',
      'channel_runs',
      'channel_runtime_messages',
      'channel_runtime_states',
      'channel_sessions',
      'channel_threads',
      'channels',
    ]);
    expect(
      (
        await db.query(
          "SELECT indexname FROM pg_indexes WHERE indexname IN ('channel_runs_active_member_idx', 'channel_audit_channel_event_idx', 'channel_messages_request_idx')",
        )
      ).rows,
    ).toHaveLength(3);
    // The foreign keys to `users` are not in the models; the migration writes them.
    await expect(
      db.exec("INSERT INTO channels (id, owner_id, title) VALUES ('bad', 'missing', 'Bad')"),
    ).rejects.toThrow();
    await expect(
      db.exec(
        "INSERT INTO command_governance_rules (user_id, pattern, pattern_type) VALUES ('missing', 'x', 'exact')",
      ),
    ).rejects.toThrow();
    await db.exec("DELETE FROM users WHERE id = 'owner'");
  }, 30_000);

  it('bumps the Channel revision for observable changes only, and replays idempotently', async () => {
    const db = await createDatabase();
    const revision = async () =>
      (await db.query<{ revision: number }>("SELECT revision FROM channels WHERE id = 'channel'"))
        .rows[0].revision;
    await db.exec(channelBaselineMigrationSql());
    await db.exec(channelBaselineMigrationSql());
    await db.exec("INSERT INTO channels (id, owner_id, title) VALUES ('channel', 'owner', 'One')");
    expect(await revision()).toBe(0);

    await db.exec(
      "INSERT INTO channel_members (id, channel_id, name, config) VALUES ('member', 'channel', 'Agent', '{}')",
    );
    expect(await revision()).toBe(1);
    await db.exec("UPDATE channel_members SET active = true WHERE id = 'member'");
    expect(await revision()).toBe(1);
    await db.exec("UPDATE channel_members SET execution_paused = true WHERE id = 'member'");
    expect(await revision()).toBe(2);
    await db.exec("UPDATE channels SET title = 'Two' WHERE id = 'channel'");
    expect(await revision()).toBe(3);
    await db.exec("UPDATE channels SET title = 'Two' WHERE id = 'channel'");
    expect(await revision()).toBe(3);
    // Audit rows are history, not observable Channel state.
    await db.exec(
      "INSERT INTO channel_audit (id, channel_id, event, target_id) VALUES ('audit', 'channel', 'x', 'channel')",
    );
    expect(await revision()).toBe(3);
    await db.exec("DELETE FROM channel_members WHERE id = 'member'");
    expect(await revision()).toBe(4);
  }, 30_000);

  it('replays 0004 and upgrades its tables without modifying messages', async () => {
    const db = await createDatabase();
    await db.exec(channelBaselineMigrationSql());
    await db.exec(`
      INSERT INTO channels (id, owner_id, title, sequence) VALUES ('channel', 'owner', 'History', 2);
      INSERT INTO channel_messages (id, channel_id, sequence, content, request_key, routing_status)
      VALUES ('first', 'channel', 1, 'First', 'first', 'assigned'),
             ('second', 'channel', 2, 'Second', 'second', 'assigned');
    `);
    const rows = async () =>
      (await db.query('SELECT * FROM channel_messages ORDER BY sequence')).rows;
    const before = await rows();
    await db.exec(channelBaselineMigrationSql());
    await db.exec(channelUpgradeMigrationSql());
    expect(await rows()).toEqual(before);
    const model = new ChannelModel(
      drizzle(db, { schema: privateSchemas }) as unknown as LobeChatDatabase,
      'owner',
    );
    expect((await model.page('channel')).messages.map((message) => message.content)).toEqual([
      'First',
      'Second',
    ]);
  }, 30_000);

  it('lets only an isolated writer coexist with the next run of its member', async () => {
    const db = await createDatabase();
    await db.exec(channelMigrationSql());
    await db.exec(`
      INSERT INTO channels (id, owner_id, title) VALUES ('channel', 'owner', 'Writers');
      INSERT INTO channel_members (id, channel_id, name, config) VALUES ('member', 'channel', 'Agent', '{}');
      INSERT INTO channel_messages (id, channel_id, sequence, content, request_key, routing_status)
        VALUES ('message', 'channel', 1, 'Work', 'request', 'assigned');
      INSERT INTO channel_jobs (id, channel_id, member_id, message_id, delivery_key)
        VALUES ('old', 'channel', 'member', 'message', 'old'), ('new', 'channel', 'member', 'message', 'new');
      INSERT INTO channel_sessions (id, channel_id, member_id, scope) VALUES ('session', 'channel', 'member', 'main');
      INSERT INTO channel_runs (id, channel_id, job_id, member_id, session_id, manifest)
        VALUES ('old-run', 'channel', 'old', 'member', 'session', '{}');
    `);
    const next =
      "INSERT INTO channel_runs (id, channel_id, job_id, member_id, session_id, manifest) VALUES ('new-run', 'channel', 'new', 'member', 'session', '{}')";
    // An unconfirmed writer still holds the member: no second writer while it is not isolated.
    await expect(db.exec(next)).rejects.toThrow(/channel_runs_active_member_idx/);
    await db.exec("UPDATE channel_runs SET isolated_at = now() WHERE id = 'old-run'");
    await db.exec(next);
    // Isolation does not pretend the writer stopped: both remain unconfirmed.
    expect(
      (await db.query('SELECT id, writer_released, physical_stopped FROM channel_runs ORDER BY id'))
        .rows,
    ).toEqual([
      { id: 'new-run', writer_released: false, physical_stopped: false },
      { id: 'old-run', writer_released: false, physical_stopped: false },
    ]);
    await expect(
      db.exec("UPDATE channel_runs SET isolated_at = NULL WHERE id = 'old-run'"),
    ).rejects.toThrow(/channel_runs_active_member_idx/);
  }, 30_000);

  describe('on tables that already exist, whoever created them', () => {
    const replayAfter = async (damage: string) => {
      const db = await createDatabase();
      await db.exec(channelBaselineMigrationSql());
      await db.exec(damage);
      return db.exec(channelBaselineMigrationSql());
    };

    it.each([
      ['a column of another type', 'ALTER TABLE channel_outbox ALTER COLUMN kind TYPE varchar(20)'],
      ['a missing column', 'ALTER TABLE command_governance_rules DROP COLUMN pattern'],
      ['an extra column', 'ALTER TABLE channels ADD COLUMN stray text'],
      ['a changed default', 'ALTER TABLE channels ALTER COLUMN sequence SET DEFAULT 5'],
      ['a missing index', 'DROP INDEX channel_runs_active_member_idx'],
      [
        'a missing foreign key',
        'ALTER TABLE channels DROP CONSTRAINT channels_owner_id_users_id_fk',
      ],
      ['a missing trigger', 'DROP TRIGGER channel_jobs_revision ON channel_jobs'],
    ])(
      'refuses %s',
      async (_name, damage) => {
        await expect(replayAfter(damage)).rejects.toThrow(
          /differ from the tenant chain definition/,
        );
      },
      30_000,
    );

    it('refuses a changed revision function', async () => {
      await expect(
        replayAfter(
          'CREATE OR REPLACE FUNCTION channel_self_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$',
        ),
      ).rejects.toThrow(/Channel revision functions differ/);
    }, 30_000);

    it('refuses a partial set instead of completing it', async () => {
      await expect(replayAfter('DROP TABLE channel_approvals')).rejects.toThrow(
        /only partly present/,
      );
    }, 30_000);
  });
});
