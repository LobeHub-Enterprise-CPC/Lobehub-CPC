import { type Client, escapeIdentifier, escapeLiteral } from 'pg';

import { ACCOUNT_LOOKUP_ROLE } from '../../../apps/server/src/services/tenantDiscovery/permissions';

type Queryable = Pick<Client, 'query'>;

/**
 * Match Console initialization: the migrate step requires the lookup role to exist
 * before any schema mutation, and runtime discovery logs in as it.
 *
 * Create-only keeps a reusable E2E cluster from resetting the credentials Console
 * already set for environments that share it. The password is E2E-local because
 * the role is created in a disposable database cluster.
 */
export const ensureAccountLookupRole = async (client: Queryable, database: string) => {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    ACCOUNT_LOOKUP_ROLE,
  ]);
  if (!exists.rowCount)
    await client.query(
      `CREATE ROLE ${escapeIdentifier(ACCOUNT_LOOKUP_ROLE)} LOGIN PASSWORD ${escapeLiteral(`${ACCOUNT_LOOKUP_ROLE}-e2e`)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
    );
  await client.query(
    `GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(ACCOUNT_LOOKUP_ROLE)}`,
  );
};
