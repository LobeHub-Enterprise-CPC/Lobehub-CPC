import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('AcceptanceOnboarding module contract', () => {
  it('links the CLI command from the business slot, not the old Apps constants', async () => {
    const result = await build({
      build: {
        minify: false,
        rollupOptions: {
          external: (id) => id !== '@/features/Apps/const' && !id.startsWith('/'),
          input: resolve(__dirname, 'AcceptanceOnboarding.tsx'),
          preserveEntrySignatures: 'strict',
        },
        write: false,
      },
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: {
          '@/features/Apps/const': resolve(__dirname, '../../Apps/const.ts'),
        },
      },
    });

    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs
      .flatMap(({ output }) => output)
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n');
    expect(code).toMatch(/import.*CLI_INSTALL_COMMAND.*from ["']@lobechat\/business-const["']/);
  });
});
