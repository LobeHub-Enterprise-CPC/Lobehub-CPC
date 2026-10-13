import { readFileSync } from 'node:fs';

/**
 * Channel tables are migrated by the enclosing enterprise chain (see
 * src/privateSchemas/channel.ts). PGlite suites apply exactly these files, in order.
 */
export const CHANNEL_MIGRATIONS = [
  '0009_channel_mvp',
  '0010_channel_attachments',
  '0017_channel_revision',
] as const;

export const readChannelMigration = (tag: (typeof CHANNEL_MIGRATIONS)[number]) =>
  readFileSync(
    new URL(`../../../../packages/enterprise/src/database/migrations/${tag}.sql`, import.meta.url),
    'utf8',
  ).replaceAll('--> statement-breakpoint', '');

/** All Channel migrations as one script for `PGlite.exec`. */
export const channelMigrationSql = () =>
  CHANNEL_MIGRATIONS.map((tag) => readChannelMigration(tag)).join('\n;\n');
