import { describe, expect, it } from 'vitest';

import clientConfig from '../vitest.config.mjs';
import serverConfig from '../vitest.config.server.mjs';

describe.each([
  ['client', clientConfig],
  ['server', serverConfig],
] as const)('standalone %s database tests', (_name, config) => {
  it('excludes only the explicitly parent-owned Channel suites', () => {
    for (const file of [
      'src/models/channel.test.ts',
      'src/models/channelEnvironment.test.ts',
      'src/models/channelMigration.test.ts',
      'src/models/channelNative.test.ts',
      'src/models/channelWorker.test.ts',
      'src/models/__tests__/channelDiscussion.test.ts',
      'src/models/__tests__/channelRead.test.ts',
    ]) {
      expect(config.test?.exclude).toContain(file);
    }
    expect(config.test?.exclude).not.toContain('src/models/__tests__/file.test.ts');
    expect(config.test?.exclude?.filter((pattern) => pattern.includes('channel'))).toHaveLength(7);
  });

  it('does not discover private migrations from the surrounding checkout', () => {
    expect(config.test?.env?.TEST_DB_EXTRA_MIGRATIONS_FOLDER).toBe('');
  });
});
