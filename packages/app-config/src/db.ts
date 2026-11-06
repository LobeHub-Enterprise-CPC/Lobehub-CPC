import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * A connection pool limit: a positive integer, or the default when unset. Anything else (`0`,
 * `-1`, `1.5`, `abc`, an empty string) fails the process at start instead of running with a
 * limit nobody chose.
 */
const poolLimit = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const getServerDBConfig = () => {
  return createEnv({
    runtimeEnv: {
      DATABASE_DRIVER: process.env.DATABASE_DRIVER || 'neon',
      DATABASE_STATEMENT_TIMEOUT: process.env.DATABASE_STATEMENT_TIMEOUT,
      DATABASE_TEST_URL: process.env.DATABASE_TEST_URL,
      DATABASE_URL: process.env.DATABASE_URL,

      DB_DISCOVERY_LOOKUP_POOL_MAX: process.env.DB_DISCOVERY_LOOKUP_POOL_MAX,
      DB_DISCOVERY_PLATFORM_POOL_MAX: process.env.DB_DISCOVERY_PLATFORM_POOL_MAX,
      DB_PLATFORM_POOL_MAX: process.env.DB_PLATFORM_POOL_MAX,
      DB_TENANT_POOL_IDLE_TIMEOUT_MS: process.env.DB_TENANT_POOL_IDLE_TIMEOUT_MS,
      DB_TENANT_POOL_MAX_CONNECTIONS: process.env.DB_TENANT_POOL_MAX_CONNECTIONS,
      DB_TENANT_POOL_MAX_POOLS: process.env.DB_TENANT_POOL_MAX_POOLS,

      KEY_VAULTS_FALLBACK_SECRET: process.env.KEY_VAULTS_FALLBACK_SECRET,
      KEY_VAULTS_SECRET: process.env.KEY_VAULTS_SECRET,

      REMOVE_GLOBAL_FILE: process.env.DISABLE_REMOVE_GLOBAL_FILE !== '0',
    },
    server: {
      DATABASE_DRIVER: z.enum(['neon', 'node']),
      // Server-side timeout (in milliseconds) for a single SQL statement.
      // When set, Postgres aborts any statement running longer than this,
      // preventing a stuck query (e.g. lock contention) from blocking indefinitely.
      // Leave unset to keep Postgres' default of no timeout.
      DATABASE_STATEMENT_TIMEOUT: z.coerce.number().optional(),
      DATABASE_TEST_URL: z.string().optional(),
      DATABASE_URL: z.string().optional(),

      // Connection pool limits. The defaults are the values these pools had before they
      // were configurable; changing one changes how many PostgreSQL connections a process
      // may hold. Tenant discovery: the account lookup pool and its platform directory pool.
      DB_DISCOVERY_LOOKUP_POOL_MAX: poolLimit(2),
      DB_DISCOVERY_PLATFORM_POOL_MAX: poolLimit(4),
      // The platform pool (`DATABASE_URL`); 10 is pg's default `max`.
      DB_PLATFORM_POOL_MAX: poolLimit(10),
      // Tenant pools: an idle tenant pool closes after this long without a lease.
      DB_TENANT_POOL_IDLE_TIMEOUT_MS: poolLimit(5 * 60_000),
      // Connections per tenant pool, and open tenant pools per process.
      DB_TENANT_POOL_MAX_CONNECTIONS: poolLimit(4),
      DB_TENANT_POOL_MAX_POOLS: poolLimit(32),

      KEY_VAULTS_FALLBACK_SECRET: z.string().optional(),
      KEY_VAULTS_SECRET: z.string().optional(),

      REMOVE_GLOBAL_FILE: z.boolean().optional(),
    },
  });
};

export const serverDBEnv = getServerDBConfig();
