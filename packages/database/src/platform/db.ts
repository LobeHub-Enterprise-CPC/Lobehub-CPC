import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { serverDBEnv } from '@/config/db';

import * as platformSchema from './schemas';

export type PlatformDatabase = NodePgDatabase<typeof platformSchema>;

let platformDB: PlatformDatabase | null = null;

/**
 * The platform connection (`DATABASE_URL`). Its schema is `public`, which only
 * holds tenant routing metadata (spec A15, FR-DI-01): only tenant resolution,
 * lifecycle checks and the control plane may use it. Business code never
 * receives this handle.
 */
export const getPlatformDB = (): PlatformDatabase => {
  if (platformDB) return platformDB;

  const connectionString = serverDBEnv.DATABASE_URL;
  if (!connectionString)
    throw new Error('`DATABASE_URL` is not set; the platform database is unavailable.');

  const statementTimeout = serverDBEnv.DATABASE_STATEMENT_TIMEOUT;
  const pool = new Pool({
    connectionString,
    ...(statementTimeout && {
      idle_in_transaction_session_timeout: statementTimeout,
      statement_timeout: statementTimeout,
    }),
  });
  // pg.Pool emits 'error' on idle clients when the backend drops; without a
  // listener Node escalates it to an uncaught exception.
  pool.on('error', (err) => {
    console.error('[PlatformPool] idle client error:', (err as NodeJS.ErrnoException).code);
  });
  platformDB = drizzle(pool, { schema: platformSchema });
  return platformDB;
};
