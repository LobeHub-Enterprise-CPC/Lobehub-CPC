// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');
const barrel = (name: string) =>
  pathToFileURL(path.resolve(__dirname, '../..', name, 'index.ts')).href;

/**
 * `db:migrate` runs under tsx, where an ES module (apps/server) imports these
 * CommonJS barrels and only sees the names Node's CJS lexer can detect. An
 * `export *` hides every name, which broke the migration in CI.
 */
describe('tenant and platform barrels imported from an ES module', () => {
  it('expose their named exports', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobe-barrel-'));
    try {
      const entry = path.join(dir, 'entry.mjs');
      writeFileSync(
        entry,
        [
          `import { LOBEHUB_TENANT_SCHEMA_VERSION, registerTenantMigrator, tenantDB } from '${barrel('tenant')}';`,
          `import { getPlatformDB, tenantDirectory } from '${barrel('platform')}';`,
          `const names = [LOBEHUB_TENANT_SCHEMA_VERSION, registerTenantMigrator, tenantDB, getPlatformDB, tenantDirectory];`,
          `process.stdout.write(String(names.every((value) => value !== undefined)));`,
        ].join('\n'),
      );
      const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 60_000,
      });
      expect(result.stderr).not.toMatch(/does not provide an export/);
      expect(result.stdout).toBe('true');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 60_000);
});
