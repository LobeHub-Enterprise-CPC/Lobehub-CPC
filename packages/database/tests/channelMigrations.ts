import { readFileSync } from 'node:fs';

/**
 * Governance and Channel tables are created by `migrations/tenant/0004_governance_channel_tables.sql`
 * (see src/privateSchemas). PGlite suites that only need those tables apply this file to a
 * database whose `public` schema stands in for the tenant and already has `users`.
 */
export const channelMigrationFile = new URL(
  '../migrations/tenant/0004_governance_channel_tables.sql',
  import.meta.url,
);

export const channelMigrationSql = () =>
  readFileSync(channelMigrationFile, 'utf8').replaceAll('--> statement-breakpoint', '');
