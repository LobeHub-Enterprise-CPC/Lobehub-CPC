import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// When this submodule is checked out inside the CPC enterprise shell repo,
// point getTestDB() (src/core/getTestDB.ts) at the enterprise chain's
// migrations too, so model tests against tables owned there (e.g. Channel
// MVP — see src/privateSchemas/channel.ts for why they live outside this
// repo's own chain) get a real schema instead of "relation does not exist".
// A no-op in the plain OSS checkout, where that directory doesn't exist.
const enterpriseMigrationsFolder = resolve(
  __dirname,
  '../../../packages/enterprise/src/database/migrations',
);
const extraMigrationsEnv = existsSync(enterpriseMigrationsFolder)
  ? { TEST_DB_EXTRA_MIGRATIONS_FOLDER: enterpriseMigrationsFolder }
  : undefined;

export default defineConfig({
  plugins: [
    {
      name: 'raw-md',
      transform(_, id) {
        if (id.endsWith('.md')) return { code: 'export default ""', map: null };
      },
    },
  ],
  optimizeDeps: {
    exclude: ['crypto', 'util', 'tty'],
    include: ['@lobehub/tts'],
  },
  test: {
    alias: {
      '@/const': resolve(__dirname, '../const/src'),
      '@/utils/errorResponse': resolve(__dirname, '../../src/utils/errorResponse'),
      '@/utils': resolve(__dirname, '../utils/src'),
      '@/database': resolve(__dirname, '../database/src'),
      '@/libs/model-runtime': resolve(__dirname, '../model-runtime/src'),
      '@/types': resolve(__dirname, '../types/src'),
      '@/config': resolve(__dirname, '../app-config/src'),
      '@/envs': resolve(__dirname, '../env/src'),
      '@/libs/trpc': resolve(__dirname, '../trpc/src'),
      '@/locales': resolve(__dirname, '../locales/src'),
      '@/business/server': resolve(__dirname, '../business-server/src'),
      '@/server/services': resolve(__dirname, '../../apps/server/src/services'),
      '@/server/modules': resolve(__dirname, '../../apps/server/src/modules'),
      '@': resolve(__dirname, '../../src'),
    },
    env: extraMigrationsEnv,
    coverage: {
      exclude: [
        'src/server/**',
        'src/repositories/dataImporter/deprecated/**',
        'src/types/**',
        'src/models/userMemory/sources/index.ts',
        'src/models/userMemory/sources/shared.ts',
        'src/models/ragEval/index.ts',
        'src/models/agentEval/index.ts',
        'src/repositories/userMemory/index.ts',
        'src/models/_template.ts',
        'src/models/__tests__/_test_template.ts',
        'src/models/web-server.ts',
        'src/core/web-server.ts',
        'src/core/db-adaptor.ts',
        'src/core/getTestDB.ts',
        'src/index.ts',
        'tests/**',
        'vitest.config*.mts',
      ],
      reporter: ['text', 'json'],
    },
    environment: 'happy-dom',
    exclude: [
      'node_modules/**/**',
      'src/server/**/**',
      'src/repositories/dataImporter/deprecated/**/**',
    ],
    server: {
      deps: {
        inline: ['vitest-canvas-mock'],
      },
    },
    setupFiles: './tests/setup-db.ts',
  },
});
