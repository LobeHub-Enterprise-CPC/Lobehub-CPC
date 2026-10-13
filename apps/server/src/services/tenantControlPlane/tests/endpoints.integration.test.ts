// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as schema from '@lobechat/database/platform';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import fixture from '../../../../../../contracts/tenant-control-plane/endpoints.json';
import { TenantEndpointsService } from '../endpoints';
import type { EndpointRequest } from '../endpointsContract';

const maintenance = process.env.ENDPOINTS_TEST_MAINTENANCE_URL;
const suite = maintenance ? describe : describe.skip;
const databases: string[] = [];
const pools: Pool[] = [];
let service: TenantEndpointsService;
const root = process.cwd();
const migrateFolder = path.join(root, 'packages/database/migrations/platform');
const request = (overrides: Partial<EndpointRequest> = {}): EndpointRequest =>
  ({ ...fixture.request, ...overrides }) as EndpointRequest;
const directory = (id: string, slug: string) => ({
  tenantId: id,
  slug,
  name: slug,
  status: 'active' as const,
  mode: 'shared_schema' as const,
  host: '127.0.0.1',
  port: 5432,
  database: 'isolated',
  deploymentRef: 'test',
  connectionVersion: 1,
  credentialBundleVersion: 1,
  runtimeSecret: 'unused',
  runtimeUsername: 'unused',
  ownerSecret: 'unused',
  ownerUsername: 'unused',
  schemaName: `isolated_${slug}`,
  schemaVersion: 1,
  tls: { enabled: false, rejectUnauthorized: true },
});
const createDatabase = async (purpose: string) => {
  const name = `endpoints_lobehub_${purpose}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: maintenance });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  databases.push(name);
  const url = new URL(maintenance!);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.href });
  pools.push(pool);
  return drizzle(pool, { schema });
};
suite('PostgreSQL endpoint projection and migration', () => {
  beforeAll(async () => {
    const db = await createDatabase('empty');
    await migrate(db, { migrationsFolder: migrateFolder });
    await migrate(db, { migrationsFolder: migrateFolder });
    await db
      .insert(schema.tenantDirectory)
      .values([directory('tenant-fixture', 'acme'), directory('tenant-other', 'beta')]);
    service = new TenantEndpointsService(db, 'https://app.example.com');
  }, 20000);
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    const folder = process.env.ENDPOINTS_TEST_EVIDENCE_DIR;
    if (folder) {
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, 'lobehub-endpoint-db-ownership.json');
      let previous: string[] = [];
      try {
        previous = JSON.parse(readFileSync(file, 'utf8')).databases;
      } catch {
        /* first retained run */
      }
      writeFileSync(
        file,
        JSON.stringify(
          {
            owner: 'lobehub-endpoints worker',
            databases: [...new Set([...previous, ...databases])],
            purpose: 'endpoint projection/migration validation',
            retained: true,
            releaseCondition: 'parent integration and browser acceptance complete',
          },
          null,
          2,
        ),
      );
    } else if (maintenance) {
      // Only databases recorded by this test invocation are disposable; no shared reset/roles.
      const admin = new Client({ connectionString: maintenance });
      await admin.connect();
      try {
        for (const database of databases) await admin.query(`DROP DATABASE "${database}"`);
      } finally {
        await admin.end();
      }
    }
  });
  it('returns NOT_READY until a snapshot was applied', async () => {
    await expect(service.get('tenant-fixture')).rejects.toMatchObject({
      code: 'ENDPOINTS_NOT_READY',
      status: 503,
    });
  });
  it('applies the frozen fixture and replays it without changing observedAt', async () => {
    const first = await service.receive(request());
    expect(first).toMatchObject({
      status: 'applied',
      acceptedVersion: 1,
      appliedVersion: 1,
      activeUrl: 'https://app.example.com/t/acme',
    });
    expect(await service.receive(request())).toEqual(first);
  });
  it('rejects event reuse and same-version mutations', async () => {
    await expect(service.receive(request({ eventId: 'another-event' }))).rejects.toMatchObject({
      code: 'ENDPOINT_VERSION_CONFLICT',
    });
    await expect(service.receive(request({ version: 2 }))).rejects.toMatchObject({
      code: 'ENDPOINT_VERSION_CONFLICT',
    });
  });
  it('applies custom entry, rejects global host collisions and leaves older snapshots superseded', async () => {
    await service.receive(fixture.customRequest as EndpointRequest);
    await expect(
      service.receive({
        ...fixture.customRequest,
        tenantId: 'tenant-other',
        eventId: 'other-event',
      } as EndpointRequest),
    ).rejects.toMatchObject({ code: 'ENDPOINT_HOST_CONFLICT', status: 409 });
    expect(await service.receive(request())).toMatchObject({
      status: 'superseded',
      appliedVersion: 2,
      activeUrl: 'https://chat.example.com',
    });
    expect((await service.get('tenant-fixture')).endpoints).toHaveLength(3);
    await expect(service.get('tenant-other')).rejects.toMatchObject({
      code: 'ENDPOINTS_NOT_READY',
    });
  });
  it('rejects takeover of the platform host', async () => {
    await expect(
      service.receive({
        ...fixture.customRequest,
        tenantId: 'tenant-other',
        eventId: 'reserved-host',
        endpoints: fixture.customRequest.endpoints.map((e) =>
          e.kind === 'custom'
            ? { ...e, host: e.id === 'custom-a' ? 'app.example.com' : e.host }
            : e,
        ),
      } as EndpointRequest),
    ).rejects.toMatchObject({ code: 'ENDPOINT_HOST_CONFLICT' });
  });
  it('serializes concurrent revisions and preserves host uniqueness', async () => {
    const result = await Promise.allSettled(
      [3, 4].map((version) =>
        service.receive(request({ eventId: `revision-${version}`, version })),
      ),
    );
    expect(result.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await service.get('tenant-fixture')).toMatchObject({
      appliedVersion: 4,
      activeUrl: 'https://app.example.com/t/acme',
    });
  });
  it('upgrades a historical database and repeats migration without losing data or records', async () => {
    const db = await createDatabase('history');
    await new PgDialect().migrate(
      readMigrationFiles({ migrationsFolder: migrateFolder }).slice(0, 4),
      db._.session,
      { migrationsFolder: migrateFolder },
    );
    await db.insert(schema.tenantDirectory).values(directory('historical-tenant', 'history'));
    await migrate(db, { migrationsFolder: migrateFolder });
    await new TenantEndpointsService(db, 'https://app.example.com').receive(
      request({ tenantId: 'historical-tenant', eventId: 'historical-endpoint' }),
    );
    await migrate(db, { migrationsFolder: migrateFolder });
    expect(
      await new TenantEndpointsService(db, 'https://app.example.com').get('historical-tenant'),
    ).toMatchObject({ appliedVersion: 1, activeUrl: 'https://app.example.com/t/history' });
  });
});
