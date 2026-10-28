import { describe, expect, it } from 'vitest';

import { ensureSelectedDirectoryListed } from './directoryList';

describe('ensureSelectedDirectoryListed', () => {
  it('prepends the current directory when the recents omit it', () => {
    expect(ensureSelectedDirectoryListed([{ path: '/repo' }], '/other')).toEqual([
      { path: '/other' },
      { path: '/repo' },
    ]);
  });

  it('keeps a recent whose source path is already the selection', () => {
    const entries = [{ git: { activeWorktree: '/repo-wt' }, path: '/repo' }];
    expect(ensureSelectedDirectoryListed(entries, '/repo')).toEqual(entries);
  });
});
