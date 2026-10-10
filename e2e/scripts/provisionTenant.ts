/** Provision the test tenant in a dedicated, disposable E2E database only. */
import path from 'node:path';

import * as platformSchema from '@lobechat/database/platform';
import { tenantDbNames } from '@lobechat/database/tenant';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, escapeIdentifier, escapeLiteral, Pool } from 'pg';

import type { DatasourceBundle } from '../../apps/server/src/services/tenantControlPlane/contracts';
import { PostgresTenantDatabaseExecutor } from '../../apps/server/src/services/tenantControlPlane/postgresExecutor';
import { PostgresControlPlaneRepository } from '../../apps/server/src/services/tenantControlPlane/postgresRepository';
import { TenantControlPlaneService } from '../../apps/server/src/services/tenantControlPlane/service';
import { E2E_TENANT } from '../src/support/tenant';

async function provisionTenant() {
  // Schema ACLs and extension placement belong to the database baseline. Never
  // apply this test baseline to the developer's normal DATABASE_URL implicitly.
  if (process.env.E2E_ISOLATED_DATABASE !== '1')
    throw new Error('E2E_ISOLATED_DATABASE=1 is required for the dedicated E2E database');
  if (!process.env.DATABASE_URL || !process.env.KEY_VAULTS_SECRET)
    throw new Error('DATABASE_URL and KEY_VAULTS_SECRET are required');

  const url = new URL(process.env.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  const names = tenantDbNames(E2E_TENANT.id);
  const admin = new Client({ connectionString: url.toString() });
  const pool = new Pool({ connectionString: url.toString() });
  try {
    await admin.connect();
    await admin.query('CREATE SCHEMA IF NOT EXISTS extensions');
    await admin.query('CREATE SCHEMA IF NOT EXISTS paradedb');
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
    const vector = await admin.query<{ schema: string }>(
      `SELECT n.nspname AS schema FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`,
    );
    if (vector.rows[0]?.schema !== 'extensions')
      await admin.query('ALTER EXTENSION vector SET SCHEMA extensions');
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_search');

    // Match Console's baseline: runtime roles can only see their tenant and
    // shared extension schemas, including pg_search's extension-owned pdb.
    const schemas = await admin.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%'
       AND nspname NOT IN ('information_schema', 'extensions', 'paradedb', 'pdb')`,
    );
    for (const { nspname } of schemas.rows)
      await admin.query(`REVOKE ALL ON SCHEMA ${escapeIdentifier(nspname)} FROM PUBLIC`);

    await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC');

    for (const role of [names.ownerUsername, names.runtimeUsername]) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (!exists.rowCount)
        await admin.query(
          `CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(`${role}-e2e`)}`,
        );
      await admin.query(
        `GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(role)}`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA extensions, paradedb TO ${escapeIdentifier(role)}`);
    }
    await admin.query(
      `CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(names.schemaName)} AUTHORIZATION ${escapeIdentifier(names.ownerUsername)}`,
    );
    await admin.query(`REVOKE ALL ON SCHEMA ${escapeIdentifier(names.schemaName)} FROM PUBLIC`);
    await admin.query(
      `GRANT USAGE ON SCHEMA ${escapeIdentifier(names.schemaName)} TO ${escapeIdentifier(names.runtimeUsername)}`,
    );

    const db = drizzle(pool, { schema: platformSchema });
    await migrate(db, { migrationsFolder: path.resolve('packages/database/migrations/platform') });
    const datasource: DatasourceBundle = {
      connectionVersion: 1,
      credentialBundleVersion: 1,
      database,
      datasourceKind: 'lobehub',
      deploymentRef: 'e2e',
      host: url.hostname,
      mode: 'shared_schema',
      port: Number(url.port || 5432),
      runtimeCredential: {
        password: `${names.runtimeUsername}-e2e`,
        username: names.runtimeUsername,
      },
      schemaName: names.schemaName,
      schemaOwner: {
        password: `${names.ownerUsername}-e2e`,
        role: names.ownerUsername,
        username: names.ownerUsername,
      },
      schemaVersion: 1,
      tenantId: E2E_TENANT.id,
      tls: { enabled: false, rejectUnauthorized: false },
    };
    const service = new TenantControlPlaneService({
      database: new PostgresTenantDatabaseExecutor(),
      isRegistrableSlug: (slug) => slug === E2E_TENANT.slug,
      repository: new PostgresControlPlaneRepository(db),
    });
    const operationId = `${E2E_TENANT.id}:lobehub`;
    await service.receiveProvision({
      datasource,
      name: 'E2E Test Tenant',
      operationId,
      rootOperationId: E2E_TENANT.id,
      slug: E2E_TENANT.slug,
      tenantId: E2E_TENANT.id,
    });
    const provision = await service.executeProvision(E2E_TENANT.id, operationId);
    if (provision.status !== 'applied' || !provision.datasourceReady)
      throw new Error(`E2E tenant provisioning failed: ${provision.errorCode}`);
    await service.receiveLifecycle({
      desiredState: 'active',
      eventId: `${E2E_TENANT.id}:activate`,
      expiresAt: null,
      freezeReasons: [],
      occurredAt: '2026-01-01T00:00:00.000Z',
      tenantId: E2E_TENANT.id,
      version: 1,
    });
    console.log(`E2E tenant ready: /t/${E2E_TENANT.slug}`);
  } finally {
    await admin.end();
    await pool.end();
  }
}

provisionTenant().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
