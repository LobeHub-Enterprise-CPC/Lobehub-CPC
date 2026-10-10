import { createHash } from 'node:crypto';

/**
 * Names Console's provisioning function derives from the tenant id (spec A2):
 * `h24` is the first 24 hex chars of sha256(tenantId), never the slug.
 */
export const tenantHash = (tenantId: string) =>
  createHash('sha256').update(tenantId, 'utf8').digest('hex').slice(0, 24);

export const tenantDbNames = (tenantId: string) => {
  const h24 = tenantHash(tenantId);
  return {
    h24,
    ownerUsername: `lh_${h24}_owner`,
    runtimeUsername: `lh_${h24}_run`,
    schemaName: `tenant_${h24}`,
  };
};

/**
 * Shared extension schemas (spec A5, FR-DI-06): pgvector lives in
 * `extensions`, pg_search in `paradedb`. Tenant roles get USAGE on both and
 * nothing else outside their schema.
 */
export const TENANT_EXTENSION_SCHEMAS = ['extensions', 'paradedb'] as const;

/**
 * Schemas an extension creates beside its install schema: pg_search 0.20+
 * adds `pdb` for its own functions. They hold no tenant data, so tenant roles
 * may keep the USAGE the extension grants, but they stay off `search_path`.
 */
export const TENANT_EXTENSION_OWNED_SCHEMAS = ['pdb'] as const;

const RESERVED_SCHEMAS = new Set(['information_schema', 'pg_catalog', 'public']);
const TENANT_SCHEMA_PATTERN = /^tenant_[\da-z][\d_a-z]{1,55}$/;

export const isTenantSchemaName = (schemaName: string) =>
  !RESERVED_SCHEMAS.has(schemaName) && TENANT_SCHEMA_PATTERN.test(schemaName);

/** `SET LOCAL search_path` for a tenant transaction. Throws on an unsafe name. */
export const tenantSearchPathSql = (schemaName: string) => {
  if (!isTenantSchemaName(schemaName)) throw new Error('TENANT_SCHEMA_NAME_INVALID');
  return `SET LOCAL search_path TO "${schemaName}", ${TENANT_EXTENSION_SCHEMAS.join(', ')}`;
};

/**
 * Elasticsearch index namespace of a tenant: the deployment's
 * `ES_INDEX_NAMESPACE` plus the tenant hash, so every tenant has its own
 * aliases, generations and migration lock.
 */
export const tenantFtsSearchNamespace = (baseNamespace: string, tenantId: string) =>
  `${baseNamespace}-${tenantHash(tenantId)}`;

/** Advisory-lock key business transactions share and lifecycle drains take exclusively (FR-DI-07). */
export const tenantDrainLockKey = (tenantId: string) => `lobehub:tenant:${tenantId}`;

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * First statement of every tenant business transaction (FR-DI-06, FR-DI-07),
 * in one round trip: pin the transaction-local search_path to the tenant and
 * take the tenant's shared drain lock, so a freeze / offline can wait for
 * in-flight transactions by taking the same lock exclusively.
 */
export const tenantTransactionPreludeSql = (schemaName: string, tenantId: string) => {
  if (!isTenantSchemaName(schemaName)) throw new Error('TENANT_SCHEMA_NAME_INVALID');
  const path = [`"${schemaName}"`, ...TENANT_EXTENSION_SCHEMAS].join(', ');
  return `SELECT set_config('search_path', ${sqlLiteral(path)}, true), pg_advisory_xact_lock_shared(hashtextextended(${sqlLiteral(tenantDrainLockKey(tenantId))}, 0))`;
};

/** Protocol schema version in the platform directory and credential bundle. */
export const LOBEHUB_TENANT_SCHEMA_VERSION = 1;

/** Tenant schema versions this build can run against. */
export const SUPPORTED_TENANT_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([
  LOBEHUB_TENANT_SCHEMA_VERSION,
]);
