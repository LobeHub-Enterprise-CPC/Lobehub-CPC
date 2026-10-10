import * as dotenv from 'dotenv';
import type { Config } from 'drizzle-kit';

dotenv.config();

/**
 * All targets use this entry point, with separate schemas and journals:
 * - `bun run db:generate`: application tables, replayed inside each tenant.
 * - `bun run db:generate:platform --name <name>`: routing metadata in public.
 * - `DRIZZLE_TARGET=tenant bunx drizzle-kit generate --name <name>`: tenant-only SSO tables.
 *
 * `db:migrate` applies both chains through the tenant-aware migration runner.
 */
const target = process.env.DRIZZLE_TARGET ?? 'app';
if (!['app', 'platform', 'tenant'].includes(target)) {
  throw new Error('Unknown DRIZZLE_TARGET. Expected "app", "platform" or "tenant".');
}

const platform = target === 'platform';
const tenant = target === 'tenant';

export default {
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  dialect: 'postgresql',
  out: platform
    ? './packages/database/migrations/platform'
    : tenant
      ? './packages/database/migrations/tenant'
      : './packages/database/migrations',
  schema: platform
    ? './packages/database/src/platform/schemas.ts'
    : tenant
      ? './packages/database/src/tenant/schemas.ts'
      : './packages/database/src/schemas',
  strict: true,
} satisfies Config;
