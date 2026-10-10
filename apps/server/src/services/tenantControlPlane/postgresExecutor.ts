import { registerBusinessTenantMigrators } from '@lobechat/business-tenant';
import {
  getTenantMigrators,
  registerTenantMigrator,
  TENANT_EXTENSION_SCHEMAS,
  TENANT_MIGRATIONS_TABLE,
  tenantDbNames,
  type TenantMigrator,
  verifyTenantRuntime,
} from '@lobechat/database/tenant';
import { Client, type ClientConfig } from 'pg';

import type { DatasourceBundle } from './contracts';
import { validateDatasourceBundle } from './datasource';
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
    if (validateDatasourceBundle(ctx.tenantId, ctx.bundle)) throw new Error('DATASOURCE_INVALID');
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

      // Namespace ownership and deterministic credentials bind the tenant.
      // Existing objects additionally require an authentic migration history.
      const names = new Set(relations.rows.map((r) => r.relname));
      if (!names.has(TENANT_MIGRATIONS_TABLE)) throw new Error('SCHEMA_NOT_EMPTY');
      for (const migrator of this.migrators())
        await migrator.verify(client, { schemaName, tenantId: ctx.tenantId }, true);
    });
  }

  async migrate(ctx: ProvisionStepContext): Promise<void> {
    await this.checkOwnership(ctx);
    const { schemaName, runtimeUsername, ownerUsername } = tenantDbNames(ctx.tenantId);
    await withClient(ctx.bundle, 'owner', async (client) => {
      // Preflight every chain before any schema mutation.
      for (const migrator of this.migrators())
        await migrator.verify(client, { schemaName, tenantId: ctx.tenantId }, true);
      // OSS chain first, then every registered post-OSS chain (Enterprise).
      for (const migrator of this.migrators())
        await migrator.run(client, { schemaName, tenantId: ctx.tenantId });
      await this.applyOwnerGrants(client, { ownerUsername, runtimeUsername, schemaName });
    });
  }

  /**
   * Grants only the owner can give (FR-DI-08 "owner" items): DML on every
   * table and sequence, the same for objects later migrations create, and
   * read-only access to the migration journals.
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
      for (const table of journals) {
        const exists = await client.query(
          `SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2`,
          [names.schemaName, table],
        );
        if (exists.rowCount) {
          await client.query(
            `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ${schema}.${ident(table)} FROM ${run}`,
          );
          const serial = await client.query<{ sequence: string | null }>(
            `SELECT pg_get_serial_sequence($1, 'id') AS sequence`,
            [`${schema}.${ident(table)}`],
          );
          if (serial.rows[0]?.sequence)
            await client.query(
              `REVOKE USAGE, UPDATE ON SEQUENCE ${serial.rows[0].sequence} FROM ${run}`,
            );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
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

  /** Verifies the bundle, actual role/schema permissions and every migration chain. */
  async verify({ bundle, tenantId }: { bundle: DatasourceBundle; tenantId: string }) {
    if (validateDatasourceBundle(tenantId, bundle)) throw new Error('DATASOURCE_INVALID');
    await withClient(bundle, 'runtime', (client) =>
      verifyTenantRuntime(client, { schemaName: bundle.schemaName, tenantId }, this.migrators()),
    );
  }
}

/** Uses the same registered distribution chains as provisioning. */
export const verifyRuntimeTenantDatabase = verifyTenantRuntime;
