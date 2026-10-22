import type { Client } from 'pg';

import type { DiscoveryCandidate } from './candidates';
import { unavailable } from './errors';
import { ACCOUNT_LOOKUP_ROLE } from './permissions';

type Queryable = Pick<Client, 'query'>;

/** OID-bound catalog validation in one round trip for the complete candidate set. */
export const verifyCandidateObjects = async (
  client: Queryable,
  candidates: DiscoveryCandidate[],
) => {
  if (candidates.length > 500) throw unavailable();
  if (!candidates.length) return;
  const result = await client.query<{ schema: string; valid: boolean }>(
    `
    SELECT wanted.schema, n.oid IS NOT NULL AND c.oid IS NOT NULL AND c.relkind IN ('r','p')
      AND pg_catalog.has_schema_privilege($2, n.oid, 'USAGE')
      AND (SELECT count(*) = 3 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('email','banned','ban_expires')
        AND pg_catalog.has_column_privilege($2, c.oid, a.attnum, 'SELECT')) AS valid
    FROM unnest($1::text[]) AS wanted(schema)
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = wanted.schema
    LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = 'users'
  `,
    [candidates.map((c) => c.schemaName), ACCOUNT_LOOKUP_ROLE],
  );
  for (const row of result.rows)
    if (!row.valid) {
      console.error('TENANT_DISCOVERY_CANDIDATE_INVALID', {
        tenantId: candidates.find((candidate) => candidate.schemaName === row.schema)?.id,
        reason: 'USERS_PRIVILEGES',
      });
      throw unavailable();
    }
  if (result.rows.length !== candidates.length) throw unavailable();
  const database = await client.query<{ database: string }>(
    'SELECT current_database() AS database',
  );
  const wrongDatabase = candidates.find((c) => c.database !== database.rows[0]?.database);
  if (wrongDatabase) {
    console.error('TENANT_DISCOVERY_CANDIDATE_INVALID', {
      tenantId: wrongDatabase.id,
      reason: 'DATABASE_BINDING',
    });
    throw unavailable();
  }
};

export const queryTenantMembership = async (
  client: Queryable,
  candidates: DiscoveryCandidate[],
  email: string,
) => {
  if (!candidates.length) return [];
  await client.query('BEGIN READ ONLY');
  try {
    await client.query('SET LOCAL row_security = off');
    await verifyCandidateObjects(client, candidates);
    // All identifiers come from the tenant-id binding, are quoted, and the email is a parameter.
    const query = candidates
      .map(
        (candidate, index) =>
          `(SELECT ${index} AS idx WHERE EXISTS (SELECT 1 FROM "${candidate.schemaName.replaceAll('"', '""')}".users
        WHERE email = $1 AND NOT (coalesce(banned,false) AND (ban_expires IS NULL OR ban_expires > now()))))`,
      )
      .join(' UNION ALL ');
    const found = await client.query<{ idx: number }>(query, [email]);
    await client.query('COMMIT');
    return found.rows.map(({ idx }) => candidates[idx]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => console.warn('TENANT_DISCOVERY_ROLLBACK_FAILED'));
    throw error;
  }
};

export const discoveryResults = (candidates: DiscoveryCandidate[]) => {
  const names = new Map<string, number>();
  for (const candidate of candidates)
    names.set(candidate.name, (names.get(candidate.name) ?? 0) + 1);
  return [...candidates]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      ...(names.get(candidate.name)! > 1
        ? { address: candidate.activeUrl.replace(/^https?:\/\//, '') }
        : {}),
    }));
};
