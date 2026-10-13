import { readFileSync } from 'node:fs';

import { enterpriseChannelMigrations } from './enterprise-test-files.mjs';

/**
 * Channel tables are migrated by the enclosing enterprise chain (see
 * src/privateSchemas/channel.ts). PGlite suites apply exactly these files, in order.
 */
export const readChannelMigration = (tag: string) =>
  readFileSync(
    new URL(`../../../../packages/enterprise/src/database/migrations/${tag}.sql`, import.meta.url),
    'utf8',
  ).replaceAll('--> statement-breakpoint', '');

/** All Channel migrations as one script for `PGlite.exec`. */
export const channelMigrationSql = () =>
  enterpriseChannelMigrations.map((tag) => readChannelMigration(tag)).join('\n;\n');
