import { registerBusinessTenantMigrators } from '@lobechat/business-tenant';
import {
  getTenantMigrators,
  LOBEHUB_TENANT_SCHEMA_VERSION,
  registerTenantMigrator,
  TENANT_EXTENSION_OWNED_SCHEMAS,
  TENANT_EXTENSION_SCHEMAS,
  TENANT_MIGRATIONS_TABLE,
  tenantDbNames,
  type TenantMigrator,
} from '@lobechat/database/tenant';
import { Client, type ClientConfig } from 'pg';

import type { DatasourceBundle } from './contracts';
import type { ProvisionStepContext, TenantDatabaseExecutor } from './service';

// Distribution chains run after the OSS chain. Every path that migrates a
// tenant schema (control plane, `db:migrate`, Docker startup) loads this module
// before reading `getTenantMigrators()`.
registerBusinessTenantMigrators(registerTenantMigrator);

/**
 * Database side of provisioning (spec FR-CP-04, FR-DI-08). Console already
 * created the schema and both roles; LobeHub connects with the credentials it
 * was sent and never creates a schema, a role or a password (A1, A13).
 *
 * Every method opens its own short-lived connection, outside the request pool
 * manager: owner connections must never reach a request pool. Errors may
 * quote server messages; the service turns them into a step code and never
 * logs or returns them.
 */

export const bundleClientConfig = (
  bundle: DatasourceBundle,
  role: 'owner' | 'runtime',
): ClientConfig => {
  const credential = role === 'owner' ? bundle.schemaOwner : bundle.runtimeCredential;
  return {
    connectionTimeoutMillis: 10_000,
    database: bundle.database,
    host: bundle.host,
    password: credential.password,
    port: bundle.port,
    ssl: bundle.tls.enabled
      ? {
          rejectUnauthorized: bundle.tls.rejectUnauthorized,
          ...(bundle.tls.ca && { ca: bundle.tls.ca }),
        }
      : false,
    user: credential.username,
  };
};

const withClient = async <T>(
  bundle: DatasourceBundle,
  role: 'owner' | 'runtime',
  fn: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = new Client(bundleClientConfig(bundle, role));
  // A dropped connection must reject the step, not crash the process.
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
};

const ident = (name: string) => {
  if (!/^[_a-z][\d_a-z]*$/.test(name)) throw new Error('UNSAFE_IDENTIFIER');
  return `"${name}"`;
};

/** Tables the runtime role may read but never write. */
const READ_ONLY_TABLES = ['tenant_metadata'];

export interface PostgresTenantDatabaseExecutorOptions {
  /** Tenant chains to run; defaults to every registered one (OSS first, then Enterprise). */
  migrators?: () => readonly TenantMigrator[];
  /** Copies default configuration into a new tenant. The OSS build has none. */
  seeders?: ((ctx: ProvisionStepContext, client: Client) => Promise<void>)[];
}

export class PostgresTenantDatabaseExecutor implements TenantDatabaseExecutor {
  constructor(private readonly options: PostgresTenantDatabaseExecutorOptions = {}) {}

  private migrators() {
    return this.options.migrators?.() ?? getTenantMigrators();
  }

  async checkOwnership(ctx: ProvisionStepContext): Promise<void> {
    const { schemaName, ownerUsername } = tenantDbNames(ctx.tenantId);
    await withClient(ctx.bundle, 'owner', async (client) => {
      const role = await client.query<{
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolsuper: boolean;
        user: string;
      }>(
        `SELECT current_user AS user, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      const attrs = role.rows[0];
      if (!attrs || attrs.user !== ownerUsername) throw new Error('OWNER_MISMATCH');
      if (attrs.rolsuper || attrs.rolcreaterole || attrs.rolcreatedb || attrs.rolbypassrls)
        throw new Error('OWNER_PRIVILEGED');

      const schema = await client.query<{ owner: string }>(
        `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`,
        [schemaName],
      );
      if (schema.rows[0]?.owner !== ownerUsername) throw new Error('SCHEMA_NOT_OWNED');

      const relations = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1`,
        [schemaName],
      );
      if (relations.rows.length === 0) return;

      // A non-empty schema is only acceptable when it is already this tenant's:
      // its marker names this tenant, or an earlier run of ours left a journal
      // without having written the marker yet.
      const names = new Set(relations.rows.map((r) => r.relname));
      if (names.has('tenant_metadata')) {
        const marker = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM ${ident(schemaName)}.tenant_metadata WHERE datasource_kind = 'lobehub'`,
        );
        if (marker.rows.length > 0) {
          if (marker.rows.every((r) => r.tenant_id === ctx.tenantId)) return;
          throw new Error('FOREIGN_MARKER');
        }
      }
      if (!names.has(TENANT_MIGRATIONS_TABLE)) throw new Error('SCHEMA_NOT_EMPTY');
    });
  }

  async migrate(ctx: ProvisionStepContext): Promise<void> {
    const { schemaName, runtimeUsername, ownerUsername } = tenantDbNames(ctx.tenantId);
    await withClient(ctx.bundle, 'owner', async (client) => {
      // OSS chain first, then every registered post-OSS chain (Enterprise).
      for (const migrator of this.migrators())
        await migrator.run(client, { schemaName, tenantId: ctx.tenantId });
      await this.applyOwnerGrants(client, { ownerUsername, runtimeUsername, schemaName });
    });
  }

  /**
   * Grants only the owner can give (FR-DI-08 "owner" items): DML on every
   * table and sequence, the same for objects later migrations create, and
   * read-only access to the marker and the migration journals.
   */
  private async applyOwnerGrants(
    client: Client,
    names: { ownerUsername: string; runtimeUsername: string; schemaName: string },
  ) {
    const schema = ident(names.schemaName);
    const owner = ident(names.ownerUsername);
    const run = ident(names.runtimeUsername);
    const journals = this.migrators().flatMap((migrator) => migrator.journalTables);
    await client.query('BEGIN');
    try {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema}
           GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${run}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema}
           GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${run}`,
      );
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${run}`,
      );
      await client.query(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${run}`,
      );
      for (const table of [...READ_ONLY_TABLES, ...journals]) {
        const exists = await client.query(
          `SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2`,
          [names.schemaName, table],
        );
        if (exists.rowCount)
          await client.query(
            `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${schema}.${ident(table)} FROM ${run}`,
          );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async writeMarker(ctx: ProvisionStepContext): Promise<void> {
    const { schemaName } = tenantDbNames(ctx.tenantId);
    await withClient(ctx.bundle, 'owner', async (client) => {
      await client.query(
        `INSERT INTO ${ident(schemaName)}.tenant_metadata (tenant_id, datasource_kind, schema_version)
         VALUES ($1, 'lobehub', $2)
         ON CONFLICT (tenant_id) DO UPDATE SET schema_version = EXCLUDED.schema_version
         WHERE ${ident(schemaName)}.tenant_metadata.datasource_kind = 'lobehub'`,
        [ctx.tenantId, String(ctx.bundle.schemaVersion)],
      );
    });
  }

  async seed(ctx: ProvisionStepContext): Promise<void> {
    const seeders = this.options.seeders ?? [];
    if (seeders.length === 0) return;
    const { schemaName } = tenantDbNames(ctx.tenantId);
    await withClient(ctx.bundle, 'owner', async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `SET LOCAL search_path TO ${ident(schemaName)}, ${TENANT_EXTENSION_SCHEMAS.join(', ')}`,
        );
        for (const seeder of seeders) await seeder(ctx, client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * As the runtime user (FR-CP-04 `verify`): it is who the bundle says, reads
   * this tenant's marker, has no USAGE outside its schema and the extension
   * schemas, no privilege on `public` tables, DML but no CREATE in its schema,
   * and cannot assume the owner role.
   */
  async verify({ bundle, tenantId }: { bundle: DatasourceBundle; tenantId: string }) {
    const { schemaName, runtimeUsername, ownerUsername } = tenantDbNames(tenantId);
    await withClient(bundle, 'runtime', async (client) => {
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
        throw new Error('RUNTIME_ROLE_INVALID');

      const marker = await client.query(
        `SELECT 1 FROM ${ident(schemaName)}.tenant_metadata
          WHERE tenant_id = $1 AND datasource_kind = 'lobehub' AND schema_version = $2`,
        [tenantId, String(LOBEHUB_TENANT_SCHEMA_VERSION)],
      );
      if (marker.rowCount !== 1) throw new Error('MARKER_MISMATCH');

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
      if (foreign.rowCount) throw new Error('CROSS_SCHEMA_USAGE');

      const create = await client.query<{ can: boolean }>(
        `SELECT has_schema_privilege(current_user, $1, 'CREATE') AS can`,
        [schemaName],
      );
      if (create.rows[0]?.can) throw new Error('RUNTIME_CAN_CREATE');

      // By OID: resolving `public.x` by name would itself need USAGE on public.
      const publicTables = await client.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
            AND has_table_privilege(current_user, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
          LIMIT 1`,
      );
      if (publicTables.rowCount) throw new Error('PUBLIC_TABLE_ACCESS');

      const readOnly = [
        ...READ_ONLY_TABLES,
        ...this.migrators().flatMap((migrator) => migrator.journalTables),
      ];
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
      if (missingDml.rowCount) throw new Error('RUNTIME_DML_MISSING');

      const writableMarker = await client.query<{ can: boolean }>(
        `SELECT has_table_privilege(current_user, format('%I.tenant_metadata', $1::text), 'INSERT, UPDATE, DELETE') AS can`,
        [schemaName],
      );
      if (writableMarker.rows[0]?.can) throw new Error('MARKER_WRITABLE');
    });
  }
}
