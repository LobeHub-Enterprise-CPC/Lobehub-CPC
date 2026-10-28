import { getTenantDiscoveryConfig } from '@lobechat/env/tenantDiscovery';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';

import { serverDBEnv } from '@/config/db';

import { unavailable } from './errors';
import { verifyLookupIdentity } from './permissions';

let lookupPool: Pool | undefined;
const pool = () => {
  if (lookupPool) return lookupPool;
  const connectionString = getTenantDiscoveryConfig().ACCOUNT_LOOKUP_DATABASE_URL;
  if (!connectionString) throw unavailable();
  lookupPool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
    // Socket close alone does not interrupt a server lock wait; PG checks peer liveness.
    options: '-c search_path=pg_catalog,pg_temp -c client_connection_check_interval=100ms',
  });
  lookupPool.on('error', () => console.error('TENANT_DISCOVERY_CONNECTION_FAILED'));
  return lookupPool;
};

const withClient = async <T>(
  source: Pool,
  signal: AbortSignal,
  work: (client: PoolClient) => Promise<T>,
  lookup: boolean,
) => {
  signal.throwIfAborted();
  // A cancelled pool wait releases its eventual connection without executing work.
  const client = await source.connect();
  if (signal.aborted) {
    client.release();
    throw unavailable();
  }
  let destroyed = false;
  const abort = () => {
    destroyed = true;
    client.release(true);
  };
  const onError = () => undefined; // rejection of the pending query carries this failure
  client.on('error', onError);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (lookup) {
      await client.query('SET search_path = pg_catalog, pg_temp');
      await verifyLookupIdentity(client);
    }
    signal.throwIfAborted();
    return await work(client);
  } finally {
    signal.removeEventListener('abort', abort);
    client.removeListener('error', onError);
    if (!destroyed) client.release();
  }
};

export const withLookupClient = <T>(
  signal: AbortSignal,
  work: (client: PoolClient) => Promise<T>,
) => withClient(pool(), signal, work, true);

let platformPool: Pool | undefined;
/** Dedicated bounded acquisition/cancellation seam; never serves business data. */
export const withDiscoveryPlatformClient = <T>(
  signal: AbortSignal,
  work: (client: PoolClient) => Promise<T>,
) => {
  if (!platformPool) {
    if (!serverDBEnv.DATABASE_URL) throw unavailable();
    platformPool = new Pool({
      connectionString: serverDBEnv.DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 5000,
      options: '-c search_path=pg_catalog,public,pg_temp -c client_connection_check_interval=100ms',
    });
    platformPool.on('error', () => console.error('TENANT_DISCOVERY_DIRECTORY_CONNECTION_FAILED'));
  }
  return withClient(platformPool, signal, work, false);
};
