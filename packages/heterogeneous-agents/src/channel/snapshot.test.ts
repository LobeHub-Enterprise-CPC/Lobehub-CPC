// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { captureChannelWorkspace } from './snapshot';

it('preserves dirty baseline and hashes actual changes without reading outside the selected workspace', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'channel-snapshot-')));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
    git('init', '-q');
    await mkdir(path.join(root, 'workspace'));
    await writeFile(path.join(root, 'workspace', 'changed.txt'), 'committed');
    await writeFile(path.join(root, 'outside.txt'), 'private');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-qm',
      'baseline',
    );
    await writeFile(path.join(root, 'workspace', 'changed.txt'), 'pre-existing dirty');
    await writeFile(path.join(root, 'outside.txt'), 'must not be exposed');
    const cwd = path.join(root, 'workspace');
    const baseline = await captureChannelWorkspace(cwd);
    expect(baseline.commit).toMatch(/^[a-f\d]{40}$/);
    expect(baseline.files.map((file) => file.path)).toEqual(['changed.txt']);
    expect(baseline.files[0].content).toBe('pre-existing dirty');
    await writeFile(path.join(cwd, 'changed.txt'), 'run result');
    await symlink('../outside.txt', path.join(cwd, 'link'));
    const final = await captureChannelWorkspace(cwd);
    expect(final.files.find((file) => file.path === 'changed.txt')?.sha256).toBe(
      createHash('sha256').update('run result').digest('hex'),
    );
    expect(final.files.find((file) => file.path === 'link')).toMatchObject({
      kind: 'symlink',
      content: '../outside.txt',
    });
    expect(JSON.stringify(final)).not.toContain('must not be exposed');
    expect(baseline.files[0].content).toBe('pre-existing dirty');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
