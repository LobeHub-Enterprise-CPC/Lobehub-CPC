import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// A distribution that renames its CLI installs only its own wrapper names.
vi.mock('./generateCliWrapper', () => ({
  binNames: () => ['acme'],
  getCliWrapperDir: () => '/wrapper',
}));

const { getEmbeddedCliPath, LOBEHUB_CLI_ENV, withEmbeddedCliEnv } =
  await import('./embeddedCliEnv');

describe('embedded CLI under a renamed build', () => {
  const name = process.platform === 'win32' ? 'acme.cmd' : 'acme';

  it('points at the wrapper the build actually writes, not `lh`', () => {
    expect(getEmbeddedCliPath('/wrapper')).toBe(path.join('/wrapper', name));
  });

  it('hands that path to external agents', () => {
    const env = withEmbeddedCliEnv({ PATH: '/usr/bin' }, '/wrapper', 'darwin');
    expect(env[LOBEHUB_CLI_ENV]).toBe(path.join('/wrapper', name));
  });
});
