import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export interface ChannelWorkspaceSnapshot {
  capturedAt: string;
  commit: string | null;
  diff: string;
  files: {
    path: string;
    sha256: string | null;
    content?: string;
    kind: 'file' | 'symlink' | 'deleted';
  }[];
  status: string;
}

/** A bounded immutable Git snapshot; preserves pre-existing dirty changes in the baseline. */
export async function captureChannelWorkspace(cwd: string): Promise<ChannelWorkspaceSnapshot> {
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)('git', ['-c', 'core.quotepath=false', ...args], {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 15000,
      })
    ).stdout;
  await git('rev-parse', '--show-toplevel');
  let commit: string | null = null;
  try {
    commit = (await git('rev-parse', '--verify', 'HEAD')).trim();
  } catch {
    /* Unborn repository. */
  }
  const status = await git('status', '--porcelain=v1', '--untracked-files=all', '--', '.');
  const names = new Set(
    (
      await git(
        'ls-files',
        '--modified',
        '--deleted',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      )
    )
      .split('\0')
      .filter(Boolean),
  );
  for (const name of (await git('diff', '--cached', '--name-only', '--relative', '-z', '--', '.'))
    .split('\0')
    .filter(Boolean))
    names.add(name);
  const files: ChannelWorkspaceSnapshot['files'] = [];
  let size = 0;
  for (const name of names) {
    const absolute = path.resolve(cwd, name);
    const relative = path.relative(cwd, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Snapshot path escaped workspace');
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        files.push({
          path: name,
          kind: 'symlink',
          sha256: createHash('sha256').update(target).digest('hex'),
          content: target,
        });
        continue;
      }
      const canonical = await realpath(absolute);
      if (!canonical.startsWith(`${cwd}${path.sep}`))
        throw new Error('Snapshot file escaped workspace');
      if (!stat.isFile()) continue;
      size += stat.size;
      if (size > 4 * 1024 * 1024)
        throw new Error('Workspace snapshot exceeds 4 MiB; narrow the change before review');
      const bytes = await readFile(absolute);
      files.push({
        path: name,
        kind: 'file',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(!bytes.includes(0) ? { content: bytes.toString('utf8') } : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        files.push({ path: name, kind: 'deleted', sha256: null });
      else throw error;
    }
  }
  return {
    capturedAt: new Date().toISOString(),
    commit,
    status,
    files,
    diff: commit
      ? await git('diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.')
      : await git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.'),
  };
}
