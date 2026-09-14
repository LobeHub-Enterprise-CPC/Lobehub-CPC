// @vitest-environment node
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('replays the consolidated Channel migration idempotently and omits the retired workspace lock table', async () => {
  const db = new PGlite();
  const sql = readFileSync(
    new URL('../../migrations/0159_channel_mvp.sql', import.meta.url),
    'utf8',
  ).replaceAll('--> statement-breakpoint', '');
  try {
    await db.exec("CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner');");
    await db.exec(sql);
    await db.exec(`
      INSERT INTO channels (id, owner_id, title) VALUES ('channel', 'owner', 'Preserved');
      INSERT INTO channel_members (id, channel_id, name, config) VALUES ('member', 'channel', 'Agent', '{}');
      INSERT INTO channel_messages (id, channel_id, sequence, content, request_key, routing_status) VALUES ('message', 'channel', 1, 'Preserve this', 'request', 'assigned');
      INSERT INTO channel_jobs (id, channel_id, member_id, message_id, blocked_reason) VALUES ('job', 'channel', 'member', 'message', 'DEVICE_OFFLINE');
      INSERT INTO channel_sessions (id, channel_id, member_id, scope) VALUES ('session', 'channel', 'member', 'main');
      INSERT INTO channel_runs (id, channel_id, member_id, job_id, session_id, manifest, activity) VALUES ('run', 'channel', 'member', 'job', 'session', '{}', 'typing');
    `);
    // A partially migrated database replays the same file without loss.
    await db.exec(sql);
    expect((await db.query('SELECT content FROM channel_messages')).rows).toEqual([
      { content: 'Preserve this' },
    ]);
    expect((await db.query('SELECT activity FROM channel_runs')).rows).toEqual([
      { activity: 'typing' },
    ]);
    expect((await db.query('SELECT blocked_reason FROM channel_jobs')).rows).toEqual([
      { blocked_reason: 'DEVICE_OFFLINE' },
    ]);
    expect(
      (await db.query("SELECT to_regclass('channel_workspace_locks') AS lock_table")).rows,
    ).toEqual([{ lock_table: null }]);
    expect(
      (
        await db.query(
          "SELECT indexname FROM pg_indexes WHERE indexname IN ('channel_runs_active_member_idx', 'channel_audit_channel_event_idx', 'channel_audit_target_event_idx')",
        )
      ).rows,
    ).toHaveLength(3);
  } finally {
    await db.close();
  }
}, 30_000);

it('backfills root authors and human invitations, not accidental replies, and preserves later removals on replay', async () => {
  const db = new PGlite();
  const migration = readFileSync(
    new URL('../../migrations/0160_channel_thread_followers.sql', import.meta.url),
    'utf8',
  );
  try {
    await db.exec("CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner');");
    await db.exec(
      readFileSync(
        new URL('../../migrations/0159_channel_mvp.sql', import.meta.url),
        'utf8',
      ).replaceAll('--> statement-breakpoint', ''),
    );
    await db.exec(`
      INSERT INTO channels (id, owner_id, title) VALUES ('c', 'owner', 'Existing');
      INSERT INTO channel_members (id, channel_id, name, config, active) VALUES
        ('a', 'c', 'Root author', '{}', true), ('b', 'c', 'Invited', '{}', true),
        ('x', 'c', 'Accidental responder', '{}', true), ('gone', 'c', 'Retired', '{}', false);
      INSERT INTO channel_messages (id, channel_id, sequence, author_member_id, content, mentions, request_key, routing_status) VALUES
        ('root', 'c', 1, 'a', 'Root', '[]', '1', 'reply'),
        ('human', 'c', 2, NULL, 'Human root', '["b"]', '2', 'directed'),
        ('empty', 'c', 3, NULL, 'Broadcast root', '[]', '3', 'assigned');
      INSERT INTO channel_threads (id, channel_id, root_message_id, root_sequence) VALUES
        ('t', 'c', 'root', 1), ('h', 'c', 'human', 2), ('e', 'c', 'empty', 3);
      INSERT INTO channel_messages (id, channel_id, thread_id, sequence, author_member_id, content, mentions, request_key, routing_status) VALUES
        ('invitation', 'c', 't', 4, NULL, '@B', '["b","b","gone"]', '4', 'directed'),
        ('accidental', 'c', 't', 5, 'x', 'Old broadcast reply', '["x"]', '5', 'reply');
    `);
    await db.exec(migration);
    expect(
      (await db.query('SELECT id, follower_member_ids FROM channel_threads ORDER BY id')).rows,
    ).toEqual([
      { id: 'e', follower_member_ids: [] },
      { id: 'h', follower_member_ids: ['b'] },
      { id: 't', follower_member_ids: ['a', 'b'] },
    ]);
    await db.exec("UPDATE channel_threads SET follower_member_ids = '[]' WHERE id = 't'");
    await db.exec(migration);
    expect(
      (await db.query("SELECT follower_member_ids FROM channel_threads WHERE id = 't'")).rows,
    ).toEqual([{ follower_member_ids: [] }]);
    expect((await db.query('SELECT count(*)::int AS count FROM channel_messages')).rows).toEqual([
      { count: 5 },
    ]);
  } finally {
    await db.close();
  }
}, 30_000);

it('backfills immutable run environments without treating released CLI writers as physically stopped', async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner');");
    for (const file of ['0159_channel_mvp', '0160_channel_thread_followers'])
      await db.exec(
        readFileSync(new URL(`../../migrations/${file}.sql`, import.meta.url), 'utf8').replaceAll(
          '--> statement-breakpoint',
          '',
        ),
      );
    await db.exec(`
      INSERT INTO channels (id, owner_id, title) VALUES ('c', 'owner', 'Preserved');
      INSERT INTO channel_members (id, channel_id, name, config) VALUES
        ('cli', 'c', 'Codex', '{"runtime":"codex","deviceId":"old-device","workingDirectory":"/old"}'),
        ('native', 'c', 'Native', '{"runtime":"native"}');
      INSERT INTO channel_messages (id, channel_id, sequence, content, request_key, routing_status) VALUES ('message', 'c', 1, 'Original', 'r', 'assigned');
      INSERT INTO channel_jobs (id, channel_id, member_id, message_id) VALUES ('j1', 'c', 'cli', 'message'), ('j2', 'c', 'native', 'message');
      INSERT INTO channel_sessions (id, channel_id, member_id, scope) VALUES ('s1', 'c', 'cli', 'main'), ('s2', 'c', 'native', 'main');
      INSERT INTO channel_runs (id, channel_id, member_id, job_id, session_id, manifest, writer_released, fence) VALUES
        ('r1', 'c', 'cli', 'j1', 's1', '{}', true, 4), ('r2', 'c', 'native', 'j2', 's2', '{}', true, 1);
    `);
    await db.exec(
      readFileSync(
        new URL('../../migrations/0161_channel_member_environment.sql', import.meta.url),
        'utf8',
      ).replaceAll('--> statement-breakpoint', ''),
    );
    expect(
      (
        await db.query(
          'SELECT id, execution_config, execution_fence, fence, physical_stopped FROM channel_runs ORDER BY id',
        )
      ).rows,
    ).toEqual([
      {
        id: 'r1',
        execution_config: { runtime: 'codex', deviceId: 'old-device', workingDirectory: '/old' },
        execution_fence: 1,
        fence: 4,
        physical_stopped: false,
      },
      {
        id: 'r2',
        execution_config: { runtime: 'native' },
        execution_fence: 1,
        fence: 1,
        physical_stopped: true,
      },
    ]);
    expect((await db.query('SELECT content FROM channel_messages')).rows).toEqual([
      { content: 'Original' },
    ]);
  } finally {
    await db.close();
  }
}, 30_000);

it('converts per-reply discussion budgets into rounds and tags in-flight work as round 1 on replay', async () => {
  const db = new PGlite();
  const load = (file: string) =>
    readFileSync(new URL(`../../migrations/${file}.sql`, import.meta.url), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '',
    );
  const rounds = load('0163_channel_discussion_rounds');
  try {
    await db.exec("CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner');");
    for (const file of [
      '0159_channel_mvp',
      '0160_channel_thread_followers',
      '0161_channel_member_environment',
      '0162_channel_discussions',
    ])
      await db.exec(load(file));
    await db.exec(`
      INSERT INTO channels (id, owner_id, title) VALUES ('c', 'owner', 'Preserved');
      INSERT INTO channel_members (id, channel_id, name, config) VALUES ('m', 'c', 'Agent', '{}');
      INSERT INTO channel_messages (id, channel_id, sequence, content, request_key, routing_status) VALUES ('request', 'c', 1, 'Discuss', 'r', 'assigned');
      INSERT INTO channel_discussions (id, channel_id, request_message_id, participant_ids, max_turns, turns_published) VALUES
        ('small', 'c', 'request', '["m"]', 6, 2), ('huge', 'c', 'request', '["m"]', 100, 0);
      INSERT INTO channel_jobs (id, channel_id, member_id, message_id, discussion_id, delivery_key, task) VALUES
        ('discuss', 'c', 'm', 'request', 'small', 'initial', '{"kind":"discuss"}'),
        ('revise', 'c', 'm', 'request', 'small', 'held:run', '{"kind":"revise","previousRunId":"run"}'),
        ('summary', 'c', 'm', 'request', 'small', 'summary', '{"kind":"summarize"}'),
        ('plain', 'c', 'm', 'request', NULL, 'plain', NULL);
    `);
    await db.exec(rounds);
    // A partially migrated database replays the same file without loss.
    await db.exec(rounds);
    expect(
      (
        await db.query(
          'SELECT id, max_rounds, round, turns_published FROM channel_discussions ORDER BY id',
        )
      ).rows,
    ).toEqual([
      { id: 'huge', max_rounds: 10, round: 1, turns_published: 0 },
      { id: 'small', max_rounds: 6, round: 1, turns_published: 2 },
    ]);
    expect(
      (
        await db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'channel_discussions' AND column_name = 'max_turns'",
        )
      ).rows,
    ).toEqual([]);
    expect((await db.query('SELECT id, task FROM channel_jobs ORDER BY id')).rows).toEqual([
      { id: 'discuss', task: { kind: 'discuss', round: 1 } },
      { id: 'plain', task: null },
      { id: 'revise', task: { kind: 'revise', previousRunId: 'run', round: 1 } },
      { id: 'summary', task: { kind: 'summarize' } },
    ]);
  } finally {
    await db.close();
  }
}, 30_000);
