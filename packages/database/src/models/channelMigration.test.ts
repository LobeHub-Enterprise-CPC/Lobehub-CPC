// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

// Migration ownership moved to the enterprise chain (see
// src/privateSchemas/channel.ts) after this test was written.
const migration = readFileSync(
  new URL(
    '../../../../../packages/enterprise/src/database/migrations/0009_channel_mvp.sql',
    import.meta.url,
  ),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

it('replays the consolidated Channel migration idempotently without losing data', async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner');");
    await db.exec(migration);
    await db.exec(`
      INSERT INTO channels (id, owner_id, title) VALUES ('channel', 'owner', 'Preserved');
      INSERT INTO channel_members (id, channel_id, name, config) VALUES ('member', 'channel', 'Agent', '{}');
      INSERT INTO channel_messages
        (id, channel_id, sequence, content, request_key, routing_status)
      VALUES ('message', 'channel', 1, 'Preserve this', 'request', 'assigned');
    `);
    await db.exec(migration);

    expect((await db.query('SELECT title FROM channels')).rows).toEqual([{ title: 'Preserved' }]);
    expect((await db.query('SELECT content FROM channel_messages')).rows).toEqual([
      { content: 'Preserve this' },
    ]);
  } finally {
    await db.close();
  }
}, 30_000);

it('creates the final Channel schema, integrity constraints, and runtime indexes', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE users (id text PRIMARY KEY)');
    await db.exec(migration);

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
    await expect(
      db.exec("INSERT INTO channels (id, owner_id, title) VALUES ('bad', 'missing', 'Bad')"),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 30_000);
