import { readFileSync } from 'node:fs';

const tenantChain = new URL('../migrations/tenant/', import.meta.url);
const baselineTag = '0004_governance_channel_tables';

/**
 * Governance and Channel tables are created by `migrations/tenant/0004_governance_channel_tables.sql`
 * and changed by the tenant-chain migrations after it (see src/privateSchemas). PGlite suites that
 * only need those tables apply them to a database whose `public` schema stands in for the tenant
 * and already has `users`.
 */
export const channelMigrationFile = new URL(`${baselineTag}.sql`, tenantChain);

const readMigration = (file: URL) =>
  readFileSync(file, 'utf8').replaceAll('--> statement-breakpoint', '');

/** Only the migration that creates the tables, for suites that replay it over existing tables. */
export const channelBaselineMigrationSql = () => readMigration(channelMigrationFile);

/** The creating migration and every later one, in journal order: the schema the models expect. */
export const channelMigrationTags = (): string[] => {
  const { entries } = JSON.parse(
    readFileSync(new URL('meta/_journal.json', tenantChain), 'utf8'),
  ) as { entries: { tag: string }[] };
  const tags = entries.map((entry) => entry.tag);
  return tags.slice(tags.indexOf(baselineTag));
};

const migrationSql = (tags: string[]) =>
  tags.map((tag) => readMigration(new URL(`${tag}.sql`, tenantChain))).join('\n;\n');

/** The migrations after the creating one: what upgrades tables it created or adopted. */
export const channelUpgradeMigrationSql = () => migrationSql(channelMigrationTags().slice(1));

export const channelMigrationSql = () => migrationSql(channelMigrationTags());
