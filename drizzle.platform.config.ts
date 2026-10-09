import type { Config } from 'drizzle-kit';

/**
 * Platform migration chain (spec FR-MD-01): `public` holds only tenant routing
 * metadata (directory, lifecycle, inbox, provision operations).
 *
 * Generate: `bunx drizzle-kit generate --config drizzle.platform.config.ts`.
 */
export default {
  dialect: 'postgresql',
  out: './packages/database/migrations/platform',
  schema: './packages/database/src/platform/schemas.ts',
  strict: true,
} satisfies Config;
