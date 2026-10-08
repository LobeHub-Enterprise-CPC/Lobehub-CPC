import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repairLegacyChannelCodexSessions } from './repairCodexSessions';

let root: string;
let db: DatabaseSync;
const record = async (id: string, provider: string, archived = false, channelInput = true) => {
  const file = path.join(root, archived ? 'archived_sessions' : 'sessions', `${id}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const content =
    [
      { type: 'session_meta', payload: { id, model_provider: provider, cwd: '/original' } },
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: channelInput
                ? JSON.stringify({
                    activeRequestMessageId: 'request',
                    [archived ? 'publicHistory' : 'newMessages']: [
                      { content: 'Keep this message' },
                    ],
                  })
                : 'An unrelated conversation',
            },
          ],
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call', arguments: '{"command":"true"}' },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n';
  await writeFile(file, content, { mode: 0o600 });
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, file, provider, 'Title', 123);
  return { content, file };
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-provider-test-')));
  db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, title TEXT, updated_at INTEGER)',
  );
});
afterEach(async () => {
  db.close();
  await rm(root, { force: true, recursive: true });
});

describe('legacy Channel Codex provider repair', () => {
  it('previews the affected sessions without changing the native store', async () => {
    const legacy = await record('legacy', 'channel-budget');
    expect(await repairLegacyChannelCodexSessions({ codexHome: root })).toEqual({
      applied: false,
      threadIds: ['legacy'],
    });
    expect(await readFile(legacy.file, 'utf8')).toBe(legacy.content);
    expect(db.prepare('SELECT model_provider FROM threads').get()?.model_provider).toBe(
      'channel-budget',
    );
  });

  it('repairs both persistent provider references without changing history, identity or dates', async () => {
    const current = await record('current', 'channel-budget');
    const archived = await record('archived', 'channel-budget', true);
    const normal = await record('normal', 'custom-provider');
    const previousDate = (await stat(current.file)).mtimeMs;
    const result = await repairLegacyChannelCodexSessions({ codexHome: root, apply: true });
    expect(result).toMatchObject({ applied: true, threadIds: ['archived', 'current'] });
    for (const [id, fixture] of [
      ['current', current],
      ['archived', archived],
    ] as const) {
      const updated = await readFile(fixture.file, 'utf8');
      expect(JSON.parse(updated.split('\n')[0]).payload).toMatchObject({
        id,
        model_provider: 'openai',
      });
      expect(updated.slice(updated.indexOf('\n'))).toBe(
        fixture.content.slice(fixture.content.indexOf('\n')),
      );
      expect(
        db.prepare('SELECT model_provider, title, updated_at FROM threads WHERE id = ?').get(id),
      ).toEqual({ model_provider: 'openai', title: 'Title', updated_at: 123 });
      expect(await readFile(path.join(result.backupDirectory!, `${id}.jsonl`), 'utf8')).toBe(
        fixture.content,
      );
    }
    expect(Math.abs((await stat(current.file)).mtimeMs - previousDate)).toBeLessThan(1);
    expect(await readFile(normal.file, 'utf8')).toBe(normal.content);
    expect(await repairLegacyChannelCodexSessions({ codexHome: root, apply: true })).toEqual({
      applied: false,
      threadIds: [],
    });
  });

  it('refuses a matching provider without Channel provenance before making changes', async () => {
    const valid = await record('a-valid', 'channel-budget');
    await record('z-unrelated', 'channel-budget', false, false);
    await expect(
      repairLegacyChannelCodexSessions({ codexHome: root, apply: true }),
    ).rejects.toThrow('provenance');
    expect(await readFile(valid.file, 'utf8')).toBe(valid.content);
    expect(
      db.prepare('SELECT model_provider FROM threads WHERE id = ?').get('a-valid')?.model_provider,
    ).toBe('channel-budget');
  });

  it('refuses disagreement between the index and rollout identity', async () => {
    await record('legacy', 'channel-budget');
    db.prepare('UPDATE threads SET id = ?').run('different');
    await expect(
      repairLegacyChannelCodexSessions({ codexHome: root, apply: true }),
    ).rejects.toThrow('provenance');
  });

  it('leaves an open native session untouched', async () => {
    const fixture = await record('active', 'channel-budget');
    const handle = await open(fixture.file, 'r');
    try {
      await expect(
        repairLegacyChannelCodexSessions({ codexHome: root, apply: true }),
      ).rejects.toThrow('Close the native session');
      expect(await readFile(fixture.file, 'utf8')).toBe(fixture.content);
      expect(db.prepare('SELECT model_provider FROM threads').get()?.model_provider).toBe(
        'channel-budget',
      );
    } finally {
      await handle.close();
    }
  });

  it('refuses a rollout outside the native session directories', async () => {
    const fixture = await record('legacy', 'channel-budget');
    const outside = path.join(root, 'unrelated.jsonl');
    await rename(fixture.file, outside);
    db.prepare('UPDATE threads SET rollout_path = ?').run(outside);
    await expect(
      repairLegacyChannelCodexSessions({ codexHome: root, apply: true }),
    ).rejects.toThrow('outside the Codex session directories');
    expect(await readFile(outside, 'utf8')).toBe(fixture.content);
  });
});
