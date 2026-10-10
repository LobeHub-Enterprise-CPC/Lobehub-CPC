import * as dotenv from 'dotenv';
import type { Config } from 'drizzle-kit';

dotenv.config();

/**
 * Both targets use this entry point, but keep separate schemas and journals:
 * - `bun run db:generate`: application tables, replayed inside each tenant.
 * - `bun run db:generate:platform --name <name>`: routing metadata in public.
 *
 * `db:migrate` applies both chains through the tenant-aware migration runner.
 */
const target = process.env.DRIZZLE_TARGET ?? 'app';
if (target !== 'app' && target !== 'platform') {
  throw new Error('Unknown DRIZZLE_TARGET. Expected "app" or "platform".');
}

const platform = target === 'platform';

export default {
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  dialect: 'postgresql',
  out: platform ? './packages/database/migrations/platform' : './packages/database/migrations',
  schema: platform
    ? './packages/database/src/platform/schemas.ts'
    : './packages/database/src/schemas',
  strict: true,
} satisfies Config;
