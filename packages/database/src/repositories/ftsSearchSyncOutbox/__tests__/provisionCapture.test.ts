// @vitest-environment node
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bundle,
  provision,
  TENANT,
} from '@/server/services/tenantControlPlane/__tests__/service.testUtils';
import { MemoryControlPlaneRepository } from '@/server/services/tenantControlPlane/memoryRepository';
import { PostgresTenantDatabaseExecutor } from '@/server/services/tenantControlPlane/postgresExecutor';
import { TenantControlPlaneService } from '@/server/services/tenantControlPlane/service';

import { materializeTenantMigrations } from '../../../tenant/migrator';
import { FtsSearchSyncOutboxRepository } from '../index';

const mocks = vi.hoisted(() => ({
  clients: [] as {
    config: { options?: string; user?: string };
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }[],
  database: undefined as unknown,
  provider: { FTS_SEARCH_PROVIDER: 'elasticsearch' },
}));

vi.mock('@/envs/ftsSearch', () => ({ ftsSearchEnv: mocks.provider }));
vi.mock('@lobechat/business-tenant', () => ({
  businessTenantAllowList: null,
  businessTenantSeeders: [],
  registerBusinessTenantMigrators: () => {},
}));
vi.mock('@/server/services/tenantDiscovery/permissions', () => ({
  ACCOUNT_LOOKUP_ROLE: 'lookup',
  requireLookupRole: vi.fn(),
  verifyLookupPermissions: vi.fn(),
}));
// Keep PostgreSQL connection/role selection observable; execute capture SQL on an isolated PGlite.
vi.mock('pg', () => ({
  Client: class {
    config: { options?: string; user?: string };
    connect = vi.fn(async () => {});
    end = vi.fn(async () => {});
    on = vi.fn();
    query = vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [] }));
    constructor(config: { options?: string; user?: string }) {
      this.config = config;
      mocks.clients.push(this);
    }
  },
}));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: () => mocks.database }));

let pglite: PGlite;
let outbox: FtsSearchSyncOutboxRepository;
let executor: PostgresTenantDatabaseExecutor;
let service: TenantControlPlaneService;
let seed: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(async () => {
  mocks.clients.length = 0;
  mocks.provider.FTS_SEARCH_PROVIDER = 'elasticsearch';
  pglite = new PGlite({ extensions: { vector } });
  await pglite.exec('CREATE EXTENSION IF NOT EXISTS vector');
  const schema = bundle().schemaName;
  await pglite.exec(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}", public`);
  const migrations = path.join(import.meta.dirname, '../../../../migrations');
  for (const folder of [migrations, path.join(migrations, 'tenant')])
    for (const migration of materializeTenantMigrations(
      readMigrationFiles({ migrationsFolder: folder }),
      schema,
    ))
      for (const statement of migration.sql)
        if (!/pg_search|bm25/i.test(statement)) await pglite.exec(statement);
  const database = drizzle({ client: pglite });
  mocks.database = database;
  // PGlite and node-postgres return different raw-result types; capture only consumes rows.
  outbox = new FtsSearchSyncOutboxRepository(
    database as unknown as ConstructorParameters<typeof FtsSearchSyncOutboxRepository>[0],
  );
  seed = vi.fn(async () => {
    await pglite.exec(`INSERT INTO users (id) VALUES ('user-1') ON CONFLICT DO NOTHING;
      INSERT INTO agents (id, user_id, title) VALUES ('agent-1', 'user-1', 'Seed agent') ON CONFLICT DO NOTHING`);
  });
  executor = new PostgresTenantDatabaseExecutor({ migrators: () => [], seeders: [seed] });
  vi.spyOn(executor, 'checkOwnership').mockResolvedValue(undefined);
  vi.spyOn(executor, 'verify').mockResolvedValue(undefined);
  vi.spyOn(executor, 'verifyDiscovery').mockResolvedValue(undefined);
  service = new TenantControlPlaneService({
    database: executor,
    isRegistrableSlug: () => true,
    repository: new MemoryControlPlaneRepository(),
  });
}, 120_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await pglite?.close();
});

const execute = async () => {
  await service.receiveProvision(provision());
  return service.executeProvision(TENANT, 'root-1:lobehub');
};

describe('Elasticsearch capture during provisioning', () => {
  it('captures seed writes after owner grants, on a short tenant-bound owner connection', async () => {
    seed.mockImplementationOnce(async () => {
      await outbox.assertCaptureInfrastructure();
      expect(
        mocks.clients[0].query.mock.calls.some(([sql]) =>
          String(sql).includes('GRANT EXECUTE ON FUNCTIONS'),
        ),
      ).toBe(true);
      await pglite.exec(
        `INSERT INTO users (id) VALUES ('user-1'); INSERT INTO agents (id, user_id) VALUES ('agent-1', 'user-1')`,
      );
    });
    expect(await execute()).toMatchObject({ status: 'applied' });
    expect(
      (await pglite.query('SELECT entity, document_id FROM fts_search_sync_outbox')).rows,
    ).toEqual([{ entity: 'agents', document_id: 'agent-1' }]);
    expect(mocks.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          config: expect.objectContaining({
            user: bundle().schemaOwner.username,
            options: `-c search_path=${bundle().schemaName},extensions,paradedb`,
          }),
        }),
      ]),
    );
    for (const client of mocks.clients) expect(client.end).toHaveBeenCalledOnce();
  });

  it('fails at migrate before seeding when capture installation fails, and retries idempotently', async () => {
    const install = vi
      .spyOn(FtsSearchSyncOutboxRepository.prototype, 'installCaptureInfrastructure')
      .mockRejectedValueOnce(new Error('capture failed'));
    expect(await execute()).toMatchObject({
      status: 'failed',
      errorCode: 'TENANT_PROVISION_FAILED',
    });
    expect(seed).not.toHaveBeenCalled();
    expect(await execute()).toMatchObject({ status: 'applied' });
    expect(install).toHaveBeenCalledTimes(2);
    await outbox.installCaptureInfrastructure();
    await outbox.assertCaptureInfrastructure();
  });

  it.each(['pg_like', 'pg_search'])('does not install capture for %s', async (provider) => {
    mocks.provider.FTS_SEARCH_PROVIDER = provider;
    const install = vi.spyOn(
      FtsSearchSyncOutboxRepository.prototype,
      'installCaptureInfrastructure',
    );
    expect(await execute()).toMatchObject({ status: 'applied' });
    expect(install).not.toHaveBeenCalled();
    expect((await pglite.query('SELECT * FROM fts_search_sync_outbox')).rows).toEqual([]);
  });

  it('rejects missing capture at provision verify without reinstalling it', async () => {
    const install = vi.spyOn(
      FtsSearchSyncOutboxRepository.prototype,
      'installCaptureInfrastructure',
    );
    seed.mockImplementationOnce(async () => {
      await pglite.exec('DROP TRIGGER IF EXISTS fts_search_sync_agents ON agents');
    });
    expect(await execute()).toMatchObject({ status: 'failed', errorCode: 'DATASOURCE_INVALID' });
    expect(install).toHaveBeenCalledOnce();
  });
});
