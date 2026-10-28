import { describe, expect, it } from 'vitest';

import { buildCloudHeteroContext } from '../cloudHeteroContext';

describe('buildCloudHeteroContext', () => {
  it('describes the ephemeral box at /workspace when no placement is given', () => {
    const context = buildCloudHeteroContext({ repos: ['lobehub/lobehub'] });

    expect(context).toContain('Your working directory is `/workspace`');
    // This deployment's sandbox pauses and resumes rather than being
    // destroyed after ~1 hour — the prompt must keep describing that.
    expect(context).toContain('pause / resume');
    expect(context).toContain('- `/workspace/lobehub`');
  });

  it('renders an explicit ephemeral placement exactly like no placement', () => {
    const repos = ['lobehub/lobehub'];

    expect(buildCloudHeteroContext({ repos, sandbox: { mode: 'ephemeral' } })).toBe(
      buildCloudHeteroContext({ repos }),
    );
  });

  it('describes a persistent instance by its place in the workspace, never by an absolute path', () => {
    const context = buildCloudHeteroContext({
      repos: ['lobehub/lobehub'],
      sandbox: { cwd: 'lobehub-main', mode: 'persistent' },
    });

    expect(context).toContain('Your working directory is `lobehub-main`');
    expect(context).toContain('persistent workspace');
    expect(context).toContain('- `./lobehub`');
    expect(context).not.toContain('/workspace');
    expect(context).not.toContain('ephemeral');
    // Code still has to reach the remote.
    expect(context).toContain('**Always commit and push**');
  });
});
