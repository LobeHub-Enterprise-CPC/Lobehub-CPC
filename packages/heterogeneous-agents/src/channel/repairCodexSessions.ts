import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const LEGACY_PROVIDER = 'channel-budget';
const NATIVE_PROVIDER = 'openai';

interface LegacyThread {
  id: string;
  rollout_path: string;
}

interface RepairPlan extends LegacyThread {
  after: string;
  before: string;
}

/** Only recognize the attributed input emitted by the removed Channel budget proxy. */
function hasChannelInput(lines: string[]): boolean {
  return lines.some((line) => {
    if (!line.trim()) return false;
    const item = JSON.parse(line);
    if (item.type !== 'response_item' || item.payload?.role !== 'user') return false;
    return item.payload.content?.some((block: { text?: string; type?: string }) => {
      if (block.type !== 'input_text' || !block.text) return false;
      try {
        const input = JSON.parse(block.text);
        return (
          typeof input.activeRequestMessageId === 'string' &&
          (Array.isArray(input.publicHistory) || Array.isArray(input.newMessages))
        );
      } catch {
        return false;
      }
    });
  });
}

async function assertRolloutClosed(file: string): Promise<void> {
  try {
    const { stdout } = await promisify(execFile)('lsof', ['-t', '--', file]);
    if (stdout.trim()) throw new Error(`Close the native session before repairing ${file}`);
  } catch (error) {
    // lsof exits 1 with no output when no process has this file open.
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    if (failure.code === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return;
    throw error;
  }
}

async function replaceRollout(file: string, content: string): Promise<void> {
  const previous = await stat(file);
  const temporary = `${file}.channel-repair-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: previous.mode & 0o777 });
    await utimes(temporary, previous.atime, previous.mtime);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Explicit, offline migration for the removed subscription-only Channel proxy.
 * A thread/resume modelProvider override does not persist this correction. Both
 * the rollout metadata and Codex's index must agree for the native app to reopen it.
 * Never install the temporary proxy into the user's config.toml.
 */
export async function repairLegacyChannelCodexSessions(options: {
  apply?: boolean;
  codexHome: string;
}): Promise<{ applied: boolean; backupDirectory?: string; threadIds: string[] }> {
  const root = await realpath(options.codexHome);
  const databases = (await readdir(root))
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  if (!databases[0]) throw new Error('No Codex state database found');
  const db = new DatabaseSync(path.join(root, databases[0]), { readOnly: !options.apply });
  const plans: RepairPlan[] = [];
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = db
      .prepare('SELECT id, rollout_path FROM threads WHERE model_provider = ? ORDER BY id')
      .all(LEGACY_PROVIDER) as unknown as LegacyThread[];
    for (const row of rows) {
      const file = await realpath(row.rollout_path);
      const relative = path.relative(root, file);
      if (!['sessions', 'archived_sessions'].includes(relative.split(path.sep)[0]))
        throw new Error(`Refusing a rollout outside the Codex session directories: ${row.id}`);
      const before = await readFile(file, 'utf8');
      const lines = before.split('\n');
      const metadata = JSON.parse(lines[0]);
      if (
        metadata.type !== 'session_meta' ||
        metadata.payload?.id !== row.id ||
        metadata.payload?.model_provider !== LEGACY_PROVIDER ||
        !hasChannelInput(lines)
      ) {
        throw new Error(`Legacy Channel provenance does not match for ${row.id}`);
      }
      metadata.payload.model_provider = NATIVE_PROVIDER;
      lines[0] = JSON.stringify(metadata) + (lines[0].endsWith('\r') ? '\r' : '');
      plans.push({ ...row, rollout_path: file, before, after: lines.join('\n') });
    }
    const threadIds = plans.map((plan) => plan.id);
    if (!options.apply || plans.length === 0) return { applied: false, threadIds };

    for (const plan of plans) await assertRolloutClosed(plan.rollout_path);
    const backupDirectory = path.join(root, 'backups', `channel-provider-${randomUUID()}`);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    for (const plan of plans) {
      await writeFile(path.join(backupDirectory, `${plan.id}.jsonl`), plan.before, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    await writeFile(
      path.join(backupDirectory, 'manifest.json'),
      JSON.stringify({
        database: databases[0],
        from: LEGACY_PROVIDER,
        to: NATIVE_PROVIDER,
        threads: plans.map(({ id, rollout_path }) => ({ id, rollout_path })),
      }),
      { flag: 'wx', mode: 0o600 },
    );

    const written: RepairPlan[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const plan of plans) {
        await assertRolloutClosed(plan.rollout_path);
        if ((await readFile(plan.rollout_path, 'utf8')) !== plan.before)
          throw new Error(`Session changed during repair: ${plan.id}`);
        const update = db
          .prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?')
          .run(NATIVE_PROVIDER, plan.id, LEGACY_PROVIDER);
        if (Number(update.changes) !== 1) throw new Error(`Session index changed: ${plan.id}`);
        await replaceRollout(plan.rollout_path, plan.after);
        written.push(plan);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      for (const plan of written.reverse()) await replaceRollout(plan.rollout_path, plan.before);
      throw error;
    }
    return { applied: true, backupDirectory, threadIds };
  } finally {
    db.close();
  }
}
