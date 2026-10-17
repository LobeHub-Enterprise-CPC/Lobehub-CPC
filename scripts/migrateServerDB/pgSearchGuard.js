/**
 * Startup guard for deployments whose full-text search resolves to ParadeDB `pg_search`.
 *
 * Migrations 0090 and 0093 skip the extension and its BM25 indexes on PostgreSQL services that do
 * not provide `pg_search` (Aiven, RDS, Neon), so `pg_like` and Elasticsearch deployments can
 * upgrade. A deployment that still selects `pg_search` there would otherwise start normally and
 * fail on every search, so the migration entrypoints stop it here with the fix instead.
 *
 * Plain CommonJS because the Docker image runs it beside `docker.cjs` without bundling.
 */

/** Mirrors the self-hosted default in `packages/env/src/ftsSearch.ts`; parity is tested. */
const DEFAULT_FTS_SEARCH_PROVIDER = 'pg_search';

/** BM25 indexes created by `0093_add_bm25_indexes_with_icu.sql`; parity is tested. */
const PG_SEARCH_BM25_INDEX_NAMES = [
  'agents_bm25_idx',
  'chat_groups_bm25_idx',
  'documents_bm25_idx',
  'files_bm25_idx',
  'knowledge_bases_bm25_idx',
  'messages_bm25_idx',
  'topics_bm25_idx',
  'user_memories_activities_bm25_idx',
  'user_memories_bm25_idx',
  'user_memories_contexts_bm25_idx',
  'user_memories_experiences_bm25_idx',
  'user_memories_identities_bm25_idx',
  'user_memories_preferences_bm25_idx',
  'user_memory_persona_documents_bm25_idx',
];

const DOCS_URL = 'https://lobehub.com/docs/self-hosting/advanced/full-text-search';

class PgSearchNotReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PgSearchNotReadyError';
  }
}

/** Unset falls back to the default; any other value is validated by the application env schema. */
const resolveFtsSearchProvider = (env) => env.FTS_SEARCH_PROVIDER ?? DEFAULT_FTS_SEARCH_PROVIDER;

/**
 * @param {(text: string) => Promise<{ rows: Record<string, unknown>[] }>} query
 * @returns {Promise<{ extensionInstalled: boolean, missingIndexes: string[] }>}
 */
const readPgSearchReadiness = async (query) => {
  const extension = await query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_search'`);
  // withTenantCatalog pins the tenant as current_schema(). A same-named index
  // on another table/schema, including a later search_path schema, is not ready.
  const indexes = await query(`
    SELECT expected.index_name
    FROM (VALUES ${PG_SEARCH_BM25_INDEX_NAMES.map(
      (name) => `('${name}', '${name.replace(/_bm25_idx$/, '')}')`,
    ).join(', ')}) AS expected(index_name, table_name)
    JOIN pg_class AS table_relation ON table_relation.relname = expected.table_name
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_index AS index_record ON index_record.indrelid = table_relation.oid
    JOIN pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE access_method.amname = 'bm25'
      AND table_namespace.nspname = current_schema()
      AND index_namespace.oid = table_namespace.oid
      AND index_relation.relname = expected.index_name
      AND index_record.indisvalid
  `);
  const present = new Set(indexes.rows.map((row) => row.index_name));

  return {
    extensionInstalled: extension.rows.length > 0,
    missingIndexes: PG_SEARCH_BM25_INDEX_NAMES.filter((name) => !present.has(name)),
  };
};

const formatPgSearchNotReadyMessage = ({ extensionInstalled, missingIndexes }, env) => {
  const problem = extensionInstalled
    ? `the database is missing ${missingIndexes.length} of its BM25 indexes (${missingIndexes.join(', ')})`
    : 'the database does not have the ParadeDB `pg_search` extension installed';

  return `------------------------------------------------------------------------------------------
❌ Full-text search is set to \`pg_search\`${env.FTS_SEARCH_PROVIDER ? '' : ' (the default)'}, but ${problem}.
LobeHub will not start, because every search would fail.

Choose one and restart:

1) Use extension-free PostgreSQL search (recommended for Aiven, RDS, Neon and most managed PostgreSQL):

   FTS_SEARCH_PROVIDER=pg_like

2) Use Elasticsearch: set FTS_SEARCH_PROVIDER=elasticsearch and its ES_* variables.

3) Keep pg_search: have the database administrator install the extension, then explicitly
   create the BM25 indexes for each affected tenant from a LobeHub source checkout.
   Run the index file on that tenant's schema-owner connection with search_path pinned to
   its schema, extensions, paradedb (never the platform connection or another tenant).
   A skipped migration remains recorded as applied; installing the extension later does
   not replay it automatically. Verify readiness again after building the indexes.

   psql "$TENANT_DATABASE_ADMIN_URL" -c 'CREATE EXTENSION IF NOT EXISTS pg_search'
   psql "$TENANT_OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 \\
     -c 'SET search_path TO "<tenant_schema>", extensions, paradedb' \\
     -f packages/database/migrations/0093_add_bm25_indexes_with_icu.sql

Details: ${DOCS_URL}
`;
};

/**
 * Throw `PgSearchNotReadyError` when the resolved provider is `pg_search` but the database cannot
 * serve it. Other providers never touch `pg_search`, so they skip the check.
 */
const assertPgSearchReady = async (query, env = process.env) => {
  if (resolveFtsSearchProvider(env) !== 'pg_search') return;

  const readiness = await readPgSearchReadiness(query);
  if (readiness.extensionInstalled && readiness.missingIndexes.length === 0) return;

  throw new PgSearchNotReadyError(formatPgSearchNotReadyMessage(readiness, env));
};

module.exports = {
  DEFAULT_FTS_SEARCH_PROVIDER,
  PG_SEARCH_BM25_INDEX_NAMES,
  PgSearchNotReadyError,
  assertPgSearchReady,
  readPgSearchReadiness,
};
