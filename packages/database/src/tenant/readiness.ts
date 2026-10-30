import type { ClientBase } from 'pg';

import { getTenantMigrators, type TenantMigrationContext, type TenantMigrator } from './migrator';
import { TENANT_EXTENSION_OWNED_SCHEMAS, TENANT_EXTENSION_SCHEMAS, tenantDbNames } from './names';
import { TenantReadinessError } from './readinessErrors';

/**
 * Security posture of a tenant's runtime connection: role attributes, schema ownership and the
 * privileges the runtime role holds. Shared by provisioning, request admission and background
 * reconciliation. Read-only. Migration state is not checked here: the migration executor verifies
 * its own journals, and business code fails where it actually uses a missing table or column.
 */
export const verifyTenantRuntime = async (
  client: Pick<ClientBase, 'query'>,
  { tenantId, schemaName }: TenantMigrationContext,
  migrators: readonly TenantMigrator[] = getTenantMigrators(),
): Promise<void> => {
  const names = tenantDbNames(tenantId);
  if (schemaName !== names.schemaName) throw new TenantReadinessError('TENANT_DIRECTORY_MISMATCH');
  const { runtimeUsername, ownerUsername } = names;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const who = await client.query<{
      member_of_owner: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolsuper: boolean;
      user: string;
    }>(
      `SELECT current_user AS user, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
                pg_has_role(current_user, $1, 'MEMBER') AS member_of_owner
           FROM pg_roles r WHERE r.rolname = current_user`,
      [ownerUsername],
    );
    const me = who.rows[0];
    if (
      !me ||
      me.user !== runtimeUsername ||
      me.rolsuper ||
      me.rolcreaterole ||
      me.rolcreatedb ||
      me.rolbypassrls ||
      me.member_of_owner
    )
      throw new TenantReadinessError('RUNTIME_ROLE_INVALID');

    const ownerRole = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1
          AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)`,
      [ownerUsername],
    );
    if (ownerRole.rowCount !== 1) throw new TenantReadinessError('OWNER_PRIVILEGED');
    const databaseCreate = await client.query<{ can: boolean }>(
      `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can`,
    );
    if (databaseCreate.rows[0]?.can) throw new TenantReadinessError('RUNTIME_CAN_CREATE_SCHEMA');
    const owned = await client.query<{ owner: string; usage: boolean }>(
      `SELECT pg_get_userbyid(nspowner) AS owner,
                has_schema_privilege(current_user, oid, 'USAGE') AS usage
           FROM pg_namespace WHERE nspname = $1`,
      [schemaName],
    );
    if (owned.rows[0]?.owner !== ownerUsername || !owned.rows[0]?.usage)
      throw new TenantReadinessError('SCHEMA_NOT_OWNED');

    const foreign = await client.query(
      `SELECT nspname FROM pg_namespace
          WHERE has_schema_privilege(current_user, oid, 'USAGE')
            AND nspname <> ALL($1::text[])
            AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'`,
      [
        [
          schemaName,
          'pg_catalog',
          'information_schema',
          ...TENANT_EXTENSION_SCHEMAS,
          ...TENANT_EXTENSION_OWNED_SCHEMAS,
        ],
      ],
    );
    if (foreign.rowCount) throw new TenantReadinessError('CROSS_SCHEMA_USAGE');

    const create = await client.query<{ can: boolean }>(
      `SELECT has_schema_privilege(current_user, $1, 'CREATE') AS can`,
      [schemaName],
    );
    if (create.rows[0]?.can) throw new TenantReadinessError('RUNTIME_CAN_CREATE');

    // By OID: resolving `public.x` by name would itself need USAGE on public.
    // WHERE predicates may be reordered; CASE prevents privilege calls on the wrong relkind.
    const publicTables = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND CASE WHEN c.relkind IN ('r', 'p', 'v', 'm', 'f')
              THEN has_table_privilege(current_user, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
              ELSE false END
          LIMIT 1`,
    );
    if (publicTables.rowCount) throw new TenantReadinessError('PUBLIC_TABLE_ACCESS');

    const publicSequences = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'S'
            AND CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege(current_user, c.oid, 'USAGE, SELECT, UPDATE')
              ELSE false END LIMIT 1`,
    );
    if (publicSequences.rowCount) throw new TenantReadinessError('PUBLIC_SEQUENCE_ACCESS');
    const sharedCreate = await client.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = ANY($1::text[])
          AND has_schema_privilege(current_user, oid, 'CREATE') LIMIT 1`,
      [[...TENANT_EXTENSION_SCHEMAS, ...TENANT_EXTENSION_OWNED_SCHEMAS]],
    );
    if (sharedCreate.rowCount) throw new TenantReadinessError('RUNTIME_CAN_CREATE');

    const readOnly = migrators.flatMap((migrator) => migrator.journalTables);
    const missingDml = await client.query(
      `SELECT 1 FROM pg_tables t
          WHERE t.schemaname = $1 AND t.tablename <> ALL($2::text[])
            AND NOT (
              has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'SELECT')
              AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')
              AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE')
              AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'DELETE'))
          LIMIT 1`,
      [schemaName, readOnly],
    );
    if (missingDml.rowCount) throw new TenantReadinessError('RUNTIME_DML_MISSING');

    const journalSequences: string[] = [];
    for (const table of readOnly) {
      const access = await client.query<{ can_read: boolean; can_write: boolean; owner: string }>(
        `SELECT has_table_privilege(current_user, c.oid, 'SELECT') AS can_read,
                  has_table_privilege(current_user, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS can_write,
                  pg_get_userbyid(c.relowner) AS owner
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
        [schemaName, table],
      );
      // A journal the schema does not hold grants nothing; an existing one must stay read-only.
      if (!access.rows[0]) continue;
      if (
        !access.rows[0].can_read ||
        access.rows[0].can_write ||
        access.rows[0].owner !== ownerUsername
      )
        throw new TenantReadinessError('MIGRATION_JOURNAL_ACCESS_INVALID');
      const serial = await client.query<{ sequence: string | null; can_write: boolean | null }>(
        `SELECT sequence, has_sequence_privilege(current_user, sequence, 'USAGE, UPDATE') AS can_write
             FROM (SELECT pg_get_serial_sequence(format('%I.%I', $1::text, $2::text), 'id') AS sequence) s`,
        [schemaName, table],
      );
      if (serial.rows[0]?.can_write)
        throw new TenantReadinessError('MIGRATION_JOURNAL_ACCESS_INVALID');
      if (serial.rows[0]?.sequence) journalSequences.push(serial.rows[0].sequence);
    }
    const ownedObjects = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
            AND pg_get_userbyid(c.relowner) <> $2 LIMIT 1`,
      [schemaName, ownerUsername],
    );
    if (ownedObjects.rowCount) throw new TenantReadinessError('SCHEMA_OBJECT_NOT_OWNED');
    const sequenceAccess = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'S'
            AND c.oid <> ALL($2::regclass[])
            AND CASE WHEN c.relkind = 'S'
              THEN NOT (has_sequence_privilege(current_user, c.oid, 'USAGE')
                        AND has_sequence_privilege(current_user, c.oid, 'SELECT')
                        AND has_sequence_privilege(current_user, c.oid, 'UPDATE'))
              ELSE false END LIMIT 1`,
      [schemaName, journalSequences],
    );
    if (sequenceAccess.rowCount) throw new TenantReadinessError('RUNTIME_SEQUENCE_ACCESS_MISSING');

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
};
