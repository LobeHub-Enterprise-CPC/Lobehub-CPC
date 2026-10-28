import { describe, expect, it } from 'vitest';

import clientConfig from '../vitest.config.mjs';
import serverConfig from '../vitest.config.server.mjs';

describe.each([
  ['client', clientConfig],
  ['server', serverConfig],
] as const)('standalone %s database tests', (_name, config) => {
  it('runs every Channel suite, whose tables the tenant chain creates', () => {
    expect(config.test?.exclude?.filter((pattern) => pattern.includes('channel'))).toEqual([]);
  });

  it('does not discover a distribution chain from the surrounding checkout', () => {
    expect(config.test?.env?.TEST_DB_EXTRA_MIGRATIONS_FOLDER).toBe('');
  });
});
