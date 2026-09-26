import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CLI_BIN_ALIASES, CLI_PRIMARY_BIN } from '../constants/identity';
import { cliVersion, createProgram } from '../program';
import { generateAliasManPage, generateRootManPage } from './roff';

const outputDir = fileURLToPath(new URL('../../man/man1/', import.meta.url));

await mkdir(outputDir, { recursive: true });

const program = createProgram();

await Promise.all([
  writeFile(`${outputDir}${CLI_PRIMARY_BIN}.1`, generateRootManPage(program, cliVersion)),
  ...CLI_BIN_ALIASES.map((alias) =>
    writeFile(`${outputDir}${alias}.1`, generateAliasManPage(CLI_PRIMARY_BIN)),
  ),
]);
