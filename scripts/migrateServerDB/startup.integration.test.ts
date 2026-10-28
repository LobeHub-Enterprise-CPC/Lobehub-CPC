// @vitest-environment node
import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { sealDirectoryData } from '../../apps/server/src/crypto/tenantKeys';
import type { directorySecretAad as directorySecretAadType } from '../../apps/server/src/services/tenantControlPlane/postgresRepository';
import type { upgradeTenantSchemas as upgradeTenantSchemasType } from '../../apps/server/src/services/tenantControlPlane/upgrade';
import * as schema from '../../packages/database/src/platform/schemas';
import { migrateUnlessReady, runStartupMigrations } from './startup';

// Only a separately supplied disposable container URL; never DATABASE_URL / DATABASE_TEST_URL.
const url = process.env.TEST_STARTUP_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('startup migrations on disposable PostgreSQL', () => {
  const clients: Client[] = [];
  const previousSecret = process.env.KEY_VAULTS_SECRET;
  const connect = async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  };
  let admin: Client;
  let directorySecretAad: typeof directorySecretAadType;
  let upgradeTenantSchemas: typeof upgradeTenantSchemasType;

  beforeAll(async () => {
    const target = new URL(url!);
    if (
      target.hostname !== '127.0.0.1' ||
      !target.port ||
      ['5432', '5433', '55441'].includes(target.port) ||
      !target.pathname.startsWith('/test_startup_')
    )
      throw new Error(
        'Use a disposable Docker database named test_startup_* on a free loopback port',
      );
    ({ directorySecretAad } =
      await import('../../apps/server/src/services/tenantControlPlane/postgresRepository'));
    ({ upgradeTenantSchemas } =
      await import('../../apps/server/src/services/tenantControlPlane/upgrade'));
    process.env.KEY_VAULTS_SECRET = 'startup-integration-secret';
    admin = await connect();
    await migrate(drizzle(admin), {
      migrationsFolder: path.resolve('packages/database/migrations/platform'),
    });
    await admin.query(
      'CREATE TABLE startup_test_receipts (tenant_id text PRIMARY KEY, runs integer NOT NULL)',
    );
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM startup_test_receipts');
    await admin.query('DELETE FROM tenant_directory');
    const db = drizzle(admin, { schema });
    for (const tenantId of ['a-broken', 'b-healthy']) {
      await db.insert(schema.tenantDirectory).values({
        connectionVersion: 1,
        credentialBundleVersion: 1,
        database: 'test_startup_p14',
        deploymentRef: 'test',
        host: '127.0.0.1',
        mode: 'shared_schema',
        name: tenantId,
        ownerSecret: sealDirectoryData('test', directorySecretAad(tenantId, 1, 'owner')),
        ownerUsername: 'test',
        port: Number(new URL(url!).port),
        runtimeSecret: sealDirectoryData('test', directorySecretAad(tenantId, 1, 'runtime')),
        runtimeUsername: 'test',
        schemaName: tenantId,
        schemaVersion: 1,
        slug: tenantId,
        status: 'active',
        tenantId,
        tls: { enabled: false, rejectUnauthorized: true },
      });
    }
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    if (previousSecret === undefined) delete process.env.KEY_VAULTS_SECRET;
    else process.env.KEY_VAULTS_SECRET = previousSecret;
  });

  const start = async (client: Client, platformFailure = false) => {
    const db = drizzle(client, { schema });
    return runStartupMigrations({
      client,
      migratePlatform: async () => {
        if (platformFailure) await client.query('SELECT * FROM missing_platform_table');
        await migrate(db, {
          migrationsFolder: path.resolve('packages/database/migrations/platform'),
        });
      },
      report: vi.fn(),
      upgradeTenants: () =>
        upgradeTenantSchemas(db, {
          executor: {
            migrate: ({ tenantId }) =>
              migrateUnlessReady(
                async () => {
                  const receipt = await client.query(
                    'SELECT 1 FROM startup_test_receipts WHERE tenant_id = $1',
                    [tenantId],
                  );
                  if (!receipt.rowCount) throw new Error('pending');
                },
                async () => {
                  if (tenantId === 'a-broken')
                    await client.query('SELECT * FROM missing_tenant_table');
                  await client.query('SELECT pg_sleep(0.05)');
                  await client.query(
                    `INSERT INTO startup_test_receipts VALUES ($1, 1)
                ON CONFLICT (tenant_id) DO UPDATE SET runs = startup_test_receipts.runs + 1`,
                    [tenantId],
                  );
                },
              ),
            verify: async () => undefined,
            verifyDiscovery: async () => undefined,
          },
        }),
    });
  };

  it('leaves the failed tenant directory untouched and migrates the following healthy tenant', async () => {
    const before = await admin.query('SELECT * FROM tenant_directory WHERE tenant_id = $1', [
      'a-broken',
    ]);
    const result = await start(await connect());
    expect(result).toEqual({
      failed: [{ reason: '42P01', tenantId: 'a-broken' }],
      migrated: ['b-healthy'],
    });
    const after = await admin.query('SELECT * FROM tenant_directory WHERE tenant_id = $1', [
      'a-broken',
    ]);
    expect(after.rows).toEqual(before.rows);
    const receipt = await admin.query(
      'SELECT runs FROM startup_test_receipts WHERE tenant_id = $1',
      ['b-healthy'],
    );
    expect(receipt.rows[0].runs).toBe(1);
  });

  it('rejects platform failure before any tenant mutation', async () => {
    await expect(start(await connect(), true)).rejects.toMatchObject({ code: '42P01' });
    expect((await admin.query('SELECT * FROM startup_test_receipts')).rowCount).toBe(0);
    expect(
      (await admin.query("SELECT 1 FROM tenant_directory WHERE status = 'disabled'")).rowCount,
    ).toBe(0);
  });

  it('two concurrent starters and a later restart migrate a tenant only once', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    await Promise.all([start(first), start(second)]);
    await start(await connect());
    const receipts = await admin.query('SELECT tenant_id, runs FROM startup_test_receipts');
    expect(receipts.rows).toEqual([{ runs: 1, tenant_id: 'b-healthy' }]);
  });
});
