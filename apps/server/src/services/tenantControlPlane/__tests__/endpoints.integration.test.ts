// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as schema from '@lobechat/database/platform';
import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  findHostEndpoint,
  findSlugEndpoint,
  loadTenantPublicEndpoint,
} from '@/server/modules/Tenant/endpoints';

import fixture from '../../../../../../contracts/tenant-control-plane/endpoints.json';
import { TenantEndpointsService } from '../endpoints';
import type { EndpointRequest } from '../endpointsContract';

const maintenance = process.env.ENDPOINTS_TEST_MAINTENANCE_URL;
// Console-generated ids are lower-case UUIDs; FIXTURE_TENANT is the id in contracts/tenant-control-plane/endpoints.json.
const FIXTURE_TENANT = '3f1c9a52-7b4e-4c1d-9e1a-0c2b8d7f6e5a';
const OTHER_TENANT = '8a6d2f40-1c3b-4e7a-b5d9-6f0e2a4c8b13';
const DAMAGED_TENANT = '0b7e41d8-52a9-4f63-8c1e-9d2a7b6f3e10';
const HISTORICAL_TENANT = '9c4d1e72-a6b3-4d58-b0f7-1e3c5a8d2f64';
const suite = maintenance ? describe : describe.skip;
const databases: string[] = [];
const pools: Pool[] = [];
let service: TenantEndpointsService;
let platform: schema.PlatformDatabase;
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
    platform = db;
    await migrate(db, { migrationsFolder: migrateFolder });
    await migrate(db, { migrationsFolder: migrateFolder });
    await db
      .insert(schema.tenantDirectory)
      .values([directory(FIXTURE_TENANT, 'acme'), directory(OTHER_TENANT, 'beta')]);
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
  it('returns a read-only default v0 before the first Console snapshot', async () => {
    expect(await service.get(FIXTURE_TENANT)).toMatchObject({
      appliedVersion: 0,
      acceptedVersion: 0,
      activeUrl: 'https://app.example.com/t/acme',
      endpoints: [{ id: 'default', kind: 'default', host: null, active: true }],
    });
    expect(await platform.select().from(schema.tenantEndpointState)).toEqual([]);
    expect(await platform.select().from(schema.tenantEndpoints)).toEqual([]);
    expect(await loadTenantPublicEndpoint(FIXTURE_TENANT, platform)).toMatchObject({
      version: 0,
    });
    const reads = vi.spyOn(platform, 'select');
    expect(await findSlugEndpoint('acme', platform)).toMatchObject({
      state: { appliedVersion: 0 },
    });
    reads.mockClear();
    await Promise.all([findSlugEndpoint('acme', platform), findSlugEndpoint('acme', platform)]);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(await findHostEndpoint('chat.example.com', platform)).toBeNull();
    await expect(service.get('unknown')).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
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
    expect(await loadTenantPublicEndpoint(FIXTURE_TENANT, platform)).toMatchObject({
      version: 1,
    });
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
    expect(await loadTenantPublicEndpoint(FIXTURE_TENANT, platform)).toMatchObject({
      version: 2,
      publicUrl: 'https://chat.example.com',
      basePath: '',
    });
    expect(await findSlugEndpoint('acme', platform)).toMatchObject({
      state: { appliedVersion: 2 },
    });
    expect(await findHostEndpoint('chat.example.com', platform)).toMatchObject({
      state: { appliedVersion: 2 },
    });
    expect(await findHostEndpoint('other.example.com', platform)).toMatchObject({
      state: { appliedVersion: 2 },
    });
    await expect(
      service.receive({
        ...fixture.customRequest,
        tenantId: OTHER_TENANT,
        eventId: 'other-event',
      } as EndpointRequest),
    ).rejects.toMatchObject({ code: 'ENDPOINT_HOST_CONFLICT', status: 409 });
    expect(await service.receive(request())).toMatchObject({
      status: 'superseded',
      appliedVersion: 2,
      activeUrl: 'https://chat.example.com',
    });
    expect((await service.get(FIXTURE_TENANT)).endpoints).toHaveLength(3);
    expect(await service.get(OTHER_TENANT)).toMatchObject({ appliedVersion: 0 });
  });
  it('rejects takeover of the platform host', async () => {
    await expect(
      service.receive({
        ...fixture.customRequest,
        tenantId: OTHER_TENANT,
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
    expect(await service.get(FIXTURE_TENANT)).toMatchObject({
      appliedVersion: 4,
      activeUrl: 'https://app.example.com/t/acme',
    });
    expect(await findHostEndpoint('chat.example.com', platform)).toBeNull();
    expect(await findHostEndpoint('other.example.com', platform)).toBeNull();
    expect(await findSlugEndpoint('acme', platform)).toMatchObject({
      state: { appliedVersion: 4 },
    });
  });
  it('refuses missing projection when a prior custom event survives', async () => {
    await platform.insert(schema.tenantDirectory).values(directory(DAMAGED_TENANT, 'damaged'));
    await service.receive({
      ...fixture.customRequest,
      tenantId: DAMAGED_TENANT,
      eventId: 'damaged-custom',
    } as EndpointRequest);
    await platform
      .delete(schema.tenantEndpoints)
      .where(eq(schema.tenantEndpoints.tenantId, DAMAGED_TENANT));
    await platform
      .delete(schema.tenantEndpointState)
      .where(eq(schema.tenantEndpointState.tenantId, DAMAGED_TENANT));
    await expect(service.get(DAMAGED_TENANT)).rejects.toMatchObject({
      code: 'ENDPOINTS_NOT_READY',
    });
  });
  it('refuses orphan endpoint rows and damaged state without default fallback', async () => {
    await platform.insert(schema.tenantEndpoints).values({
      tenantId: OTHER_TENANT,
      id: 'default',
      kind: 'default',
      host: null,
      active: true,
    });
    await expect(service.get(OTHER_TENANT)).rejects.toMatchObject({
      code: 'ENDPOINTS_NOT_READY',
    });
    await platform
      .delete(schema.tenantEndpoints)
      .where(eq(schema.tenantEndpoints.tenantId, OTHER_TENANT));
    await platform
      .insert(schema.tenantEndpointState)
      .values({ tenantId: OTHER_TENANT, acceptedVersion: 1, appliedVersion: 1 });
    await expect(service.get(OTHER_TENANT)).rejects.toMatchObject({
      code: 'ENDPOINTS_NOT_READY',
    });
  });
  it('upgrades a historical database and repeats migration without losing data or records', async () => {
    const db = await createDatabase('history');
    await new PgDialect().migrate(
      readMigrationFiles({ migrationsFolder: migrateFolder }).slice(0, 4),
      db._.session,
      { migrationsFolder: migrateFolder },
    );
    await db.insert(schema.tenantDirectory).values(directory(HISTORICAL_TENANT, 'history'));
    await migrate(db, { migrationsFolder: migrateFolder });
    await new TenantEndpointsService(db, 'https://app.example.com').receive(
      request({ tenantId: HISTORICAL_TENANT, eventId: 'historical-endpoint' }),
    );
    await migrate(db, { migrationsFolder: migrateFolder });
    expect(
      await new TenantEndpointsService(db, 'https://app.example.com').get(HISTORICAL_TENANT),
    ).toMatchObject({ appliedVersion: 1, activeUrl: 'https://app.example.com/t/history' });
    await db.insert(schema.tenantDirectory).values(directory(FIXTURE_TENANT, 'isolated'));
    expect(await loadTenantPublicEndpoint(FIXTURE_TENANT, db)).toMatchObject({
      version: 0,
      slug: 'isolated',
    });
    expect(await loadTenantPublicEndpoint(FIXTURE_TENANT, platform)).toMatchObject({
      version: 4,
      slug: 'acme',
    });
  });
});
