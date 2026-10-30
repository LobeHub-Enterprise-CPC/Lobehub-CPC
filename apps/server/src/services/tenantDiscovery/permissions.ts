import { businessTenantAllowList } from '@lobechat/business-tenant';
import type { Client } from 'pg';

export const ACCOUNT_LOOKUP_ROLE = 'tituwork_account_lookup';
type Queryable = Pick<Client, 'query'>;

export const requireLookupRole = async (client: Queryable) => {
  const result = await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [
    ACCOUNT_LOOKUP_ROLE,
  ]);
  if (!result.rowCount) throw new Error('ACCOUNT_LOOKUP_ROLE_MISSING');
};

/**
 * The lookup role reads exactly `users(email, banned, ban_expires)` and, when the distribution
 * declares one, the allow-list entry column. Effective privileges include PUBLIC grants and
 * inherited grants, not just ACL text.
 */
export const verifyLookupPermissions = async (client: Queryable, schemaName: string) => {
  const result = await client.query<{ violation: string }>(
    `
    WITH role AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1),
    ns AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2),
    relations AS MATERIALIZED (SELECT c.* FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace),
    tables AS MATERIALIZED (SELECT * FROM relations WHERE relkind IN ('r','p','v','m','f')),
    sequences AS MATERIALIZED (SELECT * FROM relations WHERE relkind = 'S')
    SELECT 'SCHEMA' AS violation WHERE NOT EXISTS (SELECT 1 FROM ns)
      OR NOT pg_catalog.has_schema_privilege($1, $2, 'USAGE')
      OR pg_catalog.has_schema_privilege($1, $2, 'CREATE')
    UNION ALL SELECT 'USERS' WHERE NOT EXISTS (SELECT 1 FROM relations WHERE relname = 'users' AND relkind IN ('r','p'))
    UNION ALL SELECT 'USERS_COLUMN' WHERE EXISTS (
      SELECT 1 FROM relations c CROSS JOIN (VALUES ('email'),('banned'),('ban_expires')) wanted(name)
      WHERE c.relname = 'users' AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = wanted.name
        AND a.attnum > 0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege($1, c.oid, a.attnum, 'SELECT')))
    UNION ALL SELECT 'RELATION' WHERE EXISTS (
      SELECT 1 FROM tables c WHERE (
        pg_catalog.has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND (pg_catalog.has_column_privilege($1, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')
            OR ((c.relname <> 'users' OR a.attname NOT IN ('email','banned','ban_expires'))
              AND (c.relname::text, a.attname::text) IS DISTINCT FROM ($3::text, $4::text)
              AND pg_catalog.has_column_privilege($1, c.oid, a.attnum, 'SELECT'))))))
    UNION ALL SELECT 'ALLOW_LIST' WHERE $3::text IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE c.relname = $3 AND c.relkind IN ('r','p') AND a.attname = $4 AND a.attnum > 0
        AND NOT a.attisdropped AND pg_catalog.has_column_privilege($1, c.oid, a.attnum, 'SELECT'))
    UNION ALL SELECT 'SEQUENCE' WHERE EXISTS (
      SELECT 1 FROM sequences c WHERE pg_catalog.has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE'))
    UNION ALL SELECT 'SECURITY_DEFINER' WHERE EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND pg_catalog.has_schema_privilege($1, n.oid, 'USAGE')
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND d.objid = p.oid AND d.deptype = 'e')
      AND pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE'))
  `,
    [
      ACCOUNT_LOOKUP_ROLE,
      schemaName,
      businessTenantAllowList?.table ?? null,
      businessTenantAllowList?.column ?? null,
    ],
  );
  if (result.rows.length) throw new Error(`ACCOUNT_LOOKUP_PRIVILEGES_${result.rows[0].violation}`);
};

/**
 * The lookup connection is the lookup role and nothing more. Its one allowed membership is the
 * administration grant PostgreSQL 16+ gives the non-superuser that created it (managed PostgreSQL
 * has no superuser): ADMIN only, so the creator neither inherits nor can SET to its privileges.
 */
export const verifyLookupIdentity = async (client: Queryable) => {
  const result = await client.query<{ valid: boolean }>(
    `
    SELECT session_user = $1 AND current_user = $1 AND rolcanlogin
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE (m.roleid = r.oid OR m.member = r.oid)
        AND NOT (m.roleid = r.oid AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))
      AND NOT pg_catalog.has_database_privilege($1, current_database(), 'CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND refobjid = r.oid AND deptype = 'o') AS valid
    FROM pg_catalog.pg_roles r WHERE rolname = $1
  `,
    [ACCOUNT_LOOKUP_ROLE],
  );
  if (!result.rows[0]?.valid) throw new Error('ACCOUNT_LOOKUP_IDENTITY_INVALID');
};
