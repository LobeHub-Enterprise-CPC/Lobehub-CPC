// @vitest-environment node
/**
 * tenant-profile on a real PostgreSQL: the directory slug, the alias set, slug uniqueness across both
 * tables under concurrency, alias resolution for routing, and cascade on unregister. Runs only when
 * DATABASE_TEST_URL points at a server where the connecting role may create databases; otherwise
 * skipped. Everything happens inside one throw-away database.
 */
import path from 'node:path';

import * as platformSchema from '@lobechat/database/platform';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { invalidateEndpointRouting } from '@/server/modules/Tenant/endpointCache';
import { findSlugEndpoint } from '@/server/modules/Tenant/endpoints';

import { PostgresControlPlaneRepository } from '../postgresRepository';
import { TenantControlPlaneService } from '../service';
import { bundle, database, provision } from './service.testUtils';

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://app.test', INTERNAL_APP_URL: 'http://internal.test' },
}));

const ADMIN_URL = process.env.DATABASE_TEST_URL;
const suite = ADMIN_URL ? describe : describe.skip;
const DB_NAME = `lobehub_profile_${process.pid}_${Date.now()}`;

let counter = 0;
const newTenant = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

suite('tenant-profile on PostgreSQL', () => {
  let pool: Pool;
  let platformDB: ReturnType<typeof drizzle<typeof platformSchema>>;
  let executor: ReturnType<typeof database>;
  let service: TenantControlPlaneService;
  const previousSecret = process.env.KEY_VAULTS_SECRET;

  beforeAll(async () => {
    process.env.KEY_VAULTS_SECRET = 'profile-integration-secret';
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE "${DB_NAME}" TEMPLATE template0`);
    await root.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;
    pool = new Pool({ connectionString: url.href, max: 12 });
    platformDB = drizzle(pool, { schema: platformSchema });
    const migrationsFolder = path.join(process.cwd(), 'packages/database/migrations/platform');
    // Twice: a rerun of the platform chain changes nothing.
    await migrate(platformDB, { migrationsFolder });
    await migrate(platformDB, { migrationsFolder });
    executor = database();
    service = new TenantControlPlaneService({
      database: executor,
      destruction: { drainBudgetMs: 600, drainPollMs: 50, retirePool: () => true },
      isRegistrableSlug: (slug) => slug !== 'admin',
      repository: new PostgresControlPlaneRepository(platformDB),
    });
  }, 60_000);

  afterAll(async () => {
    process.env.KEY_VAULTS_SECRET = previousSecret;
    await pool?.end();
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await root.end();
  }, 60_000);

  const register = async (slug: string, tenantId = newTenant()) => {
    const request = provision({
      datasource: bundle(tenantId),
      name: slug,
      operationId: `op-${tenantId}`,
      slug,
      tenantId,
    });
    await service.receiveProvision(request);
    expect((await service.executeProvision(tenantId, request.operationId)).status).toBe('applied');
    return { request, tenantId };
  };
  const profile = (
    tenantId: string,
    over: Partial<Parameters<TenantControlPlaneService['receiveProfile']>[0]> = {},
  ) => ({
    eventId: `profile:${tenantId}:${over.version ?? 2}`,
    formerSlugs: [],
    name: 'Renamed',
    slug: 'renamed',
    tenantId,
    version: 2,
    ...over,
  });
  const stored = async (tenantId: string) => ({
    aliases: (
      await pool.query('SELECT slug FROM tenant_slug_alias WHERE tenant_id = $1 ORDER BY slug', [
        tenantId,
      ])
    ).rows.map((row) => row.slug),
    directory: (
      await pool.query(
        'SELECT name, slug, profile_version AS version FROM tenant_directory WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0],
  });
  const lookup = (slug: string) => {
    invalidateEndpointRouting();
    return findSlugEndpoint(slug, platformDB);
  };

  it('applies a profile: name, slug, version and the alias set land together', async () => {
    const { tenantId } = await register('alpha');
    const result = await service.receiveProfile(
      profile(tenantId, { formerSlugs: ['alpha'], name: 'Alpha Inc', slug: 'alpha-inc' }),
    );
    expect(result).toMatchObject({ appliedVersion: 2, slug: 'alpha-inc', status: 'applied' });
    expect(await stored(tenantId)).toEqual({
      aliases: ['alpha'],
      directory: { name: 'Alpha Inc', slug: 'alpha-inc', version: 2 },
    });
    expect(await service.getOverview(tenantId)).toMatchObject({ slug: 'alpha-inc' });
  });

  it('orders revisions: superseded, idempotent and conflicting repeats', async () => {
    const { tenantId } = await register('bravo');
    const v3 = profile(tenantId, { formerSlugs: ['bravo'], slug: 'bravo-3', version: 3 });
    await service.receiveProfile(v3);
    expect(await service.receiveProfile(v3)).toMatchObject({ status: 'applied', version: 3 });
    expect(
      await service.receiveProfile(profile(tenantId, { slug: 'bravo-2', version: 2 })),
    ).toMatchObject({ appliedVersion: 3, slug: 'bravo-3', status: 'superseded' });
    await expect(service.receiveProfile({ ...v3, name: 'Different' })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(await stored(tenantId)).toMatchObject({
      aliases: ['bravo'],
      directory: { slug: 'bravo-3', version: 3 },
    });
  });

  it('resolves a former slug to the tenant, with the current slug on the entry', async () => {
    const { tenantId } = await register('charlie');
    await service.receiveProfile(
      profile(tenantId, { formerSlugs: ['charlie'], slug: 'charlie-co' }),
    );
    expect(await lookup('charlie-co')).toMatchObject({ slug: 'charlie-co', tenantId });
    expect(await lookup('charlie')).toMatchObject({ slug: 'charlie-co', tenantId });
    expect(await lookup('never-registered')).toBeNull();
  });

  it('refuses another tenant slug or alias and writes nothing', async () => {
    const a = await register('delta');
    const b = await register('echo');
    await service.receiveProfile(profile(a.tenantId, { formerSlugs: ['delta'], slug: 'delta-co' }));
    const before = await stored(b.tenantId);
    for (const over of [
      { slug: 'delta-co' },
      { slug: 'delta' },
      { formerSlugs: ['delta'], slug: 'echo-co' },
    ])
      await expect(service.receiveProfile(profile(b.tenantId, over))).rejects.toMatchObject({
        code: 'SLUG_CONFLICT',
        status: 409,
      });
    expect(await stored(b.tenantId)).toEqual(before);
    // The former slug of a renamed tenant cannot be provisioned for someone else either.
    await expect(
      service.receiveProvision(
        provision({
          datasource: bundle(newTenant()),
          operationId: 'op-someone-else',
          slug: 'delta',
          tenantId: newTenant(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_INVALID' });
  });

  it('lets a tenant take one of its own former slugs back', async () => {
    const { tenantId } = await register('foxtrot');
    await service.receiveProfile(
      profile(tenantId, { formerSlugs: ['foxtrot'], slug: 'foxtrot-co' }),
    );
    await service.receiveProfile(
      profile(tenantId, { formerSlugs: ['foxtrot-co'], slug: 'foxtrot', version: 3 }),
    );
    expect(await stored(tenantId)).toEqual({
      aliases: ['foxtrot-co'],
      directory: expect.objectContaining({ slug: 'foxtrot', version: 3 }),
    });
    expect(await lookup('foxtrot-co')).toMatchObject({ slug: 'foxtrot', tenantId });
  });

  it('lets only one of two concurrent claims on the same slug win', async () => {
    const a = await register('golf');
    const b = await register('hotel');
    const results = await Promise.allSettled([
      service.receiveProfile(profile(a.tenantId, { slug: 'contested' })),
      service.receiveProfile(profile(b.tenantId, { slug: 'contested' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'SLUG_CONFLICT' });
    const owners = await pool.query(
      `SELECT tenant_id FROM tenant_directory WHERE slug = 'contested'`,
    );
    expect(owners.rowCount).toBe(1);
  });

  it('never leaves a slug as both a directory slug and an alias under crossing claims', async () => {
    const a = await register('india');
    const b = await register('juliet');
    // A renames away from india while B tries to take india as its new slug and as an alias.
    await Promise.allSettled([
      service.receiveProfile(profile(a.tenantId, { formerSlugs: ['india'], slug: 'india-co' })),
      service.receiveProfile(profile(b.tenantId, { formerSlugs: ['india'], slug: 'juliet-co' })),
    ]);
    const both = await pool.query(
      'SELECT d.slug FROM tenant_directory d JOIN tenant_slug_alias a ON a.slug = d.slug',
    );
    expect(both.rowCount).toBe(0);
    const owners = await pool.query(`SELECT tenant_id FROM tenant_slug_alias WHERE slug = 'india'`);
    expect(owners.rowCount).toBeLessThanOrEqual(1);
  });

  it('keeps a renamed tenant renamed when its failed provision is retried', async () => {
    const tenantId = newTenant();
    const request = provision({
      datasource: bundle(tenantId),
      name: 'Kilo',
      operationId: `op-${tenantId}`,
      slug: 'kilo',
      tenantId,
    });
    await service.receiveProvision(request);
    executor.verify.mockRejectedValueOnce(new Error('transient'));
    expect((await service.executeProvision(tenantId, request.operationId)).status).toBe('failed');
    // The directory row exists by now, so the profile can be written while the provision is stuck.
    await service.receiveProfile(
      profile(tenantId, { formerSlugs: ['kilo'], name: 'Kilo Co', slug: 'kilo-co' }),
    );
    expect(await service.receiveProvision(request)).toMatchObject({ status: 'received' });
    expect((await service.executeProvision(tenantId, request.operationId)).status).toBe('applied');
    expect((await stored(tenantId)).directory).toEqual({
      name: 'Kilo Co',
      slug: 'kilo-co',
      version: 2,
    });
  });

  it('is not found for a tenant that was never provisioned here', async () => {
    await expect(service.receiveProfile(profile(newTenant()))).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
      status: 404,
    });
  });

  it('removes the aliases with the tenant when it is unregistered', async () => {
    const { tenantId } = await register('lima');
    await service.receiveProfile(profile(tenantId, { formerSlugs: ['lima'], slug: 'lima-co' }));
    const operationId = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
    for (const phase of ['barrier', 'drain', 'unregister'] as const)
      await service.destruction.apply({ destroyOperationId: operationId, phase, tenantId });
    expect((await stored(tenantId)).aliases).toEqual([]);
    expect(await lookup('lima')).toBeNull();
    expect(await lookup('lima-co')).toBeNull();
  });
});
