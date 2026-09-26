import { Command } from 'commander';
import { expect, it, vi } from 'vitest';

import { generateRootManPage } from './roff';

vi.mock('../constants/identity', async (original) => ({
  ...(await original<object>()),
  CLI_BIN_ALIASES: [],
  CLI_CONFIG_DIR_NAME: '.private-workspace',
  CLI_DISPLAY_NAME: 'Private Workspace CLI',
  CLI_HOME_ENV_NAMES: ['PRIVATE_HOME'],
  CLI_PRIMARY_BIN: 'private-cli',
  CLI_PRODUCT_NAME: 'Private Workspace',
}));
vi.mock('../pkg', () => ({ cliPackageName: '@private/cli' }));
it('uses the branded binary, config directory and aliases in generated manuals', () => {
  const output = generateRootManPage(new Command().name('private-cli'), '1.0.0');
  expect(output).toContain(String.raw`~/.private\-workspace/credentials.json`);
  expect(output).toContain(String.raw`private\-cli login`);
  expect(output).not.toMatch(/LobeHub|lobehub|\.BR lobe|\.B lh /);
});
