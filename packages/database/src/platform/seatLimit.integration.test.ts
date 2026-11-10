// @vitest-environment node
/**
 * The seat limit on a real PostgreSQL: refusal at the limit, no limit, a limit lowered below the
 * members, and concurrent creators that must never exceed it. Runs only when DATABASE_TEST_URL points
 * at a server where the connecting role may create databases; otherwise skipped. Everything happens
 * inside one throw-away database.
 */
import path from 'node:path';

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../schemas';
import type { LobeChatDatabase } from '../type';
import * as platformSchema from './schemas';
import { assertSeatAvailable, SeatLimitError, withSeatLimit } from './seatLimit';

const ADMIN_URL = process.env.DATABASE_TEST_URL;
const suite = ADMIN_URL ? describe : describe.skip;
const DB_NAME = `lobehub_seat_${process.pid}_${Date.now()}`;
const TENANT = '7a0c3d2e-1111-4222-8333-944455556666';

suite('tenant seat limit on PostgreSQL', () => {
  let pool: Pool;
  let db: LobeChatDatabase;
  let platformDB: ReturnType<typeof drizzle<typeof platformSchema>>;
  const platform = () => platformDB as never;

  beforeAll(async () => {
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE "${DB_NAME}" TEMPLATE template0`);
    await root.end();
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;
    pool = new Pool({ connectionString: url.href, max: 30 });
    platformDB = drizzle(pool, { schema: platformSchema });
    db = drizzle(pool, { schema }) as unknown as LobeChatDatabase;
    await migrate(platformDB, {
      migrationsFolder: path.join(__dirname, '../../migrations/platform'),
    });
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({ users: schema.users }),
    );
    for (const statement of statements) await pool.query(statement);
    await platformDB.insert(platformSchema.tenantDirectory).values({
      connectionVersion: 1,
      credentialBundleVersion: 1,
      database: 'lobehub',
      deploymentRef: 'default',
      host: 'pg.test',
      mode: 'shared_schema',
      name: 'Acme',
      ownerSecret: 'x',
      ownerUsername: 'owner',
      port: 5432,
      runtimeSecret: 'x',
      runtimeUsername: 'run',
      schemaName: 'tenant_acme',
      schemaVersion: 1,
      slug: 'acme',
      status: 'active',
      tenantId: TENANT,
      tls: { enabled: false, rejectUnauthorized: false },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await root.end();
  }, 60_000);

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE users`);
  });

  const setLimit = (seatLimit: number | null) =>
    platformDB
      .update(platformSchema.tenantDirectory)
      .set({ seatLimit })
      .where(sql`${platformSchema.tenantDirectory.tenantId} = ${TENANT}`);
  const members = async () => (await db.select().from(schema.users)).length;
  const join = (n: number) =>
    withSeatLimit(
      db,
      TENANT,
      (tx) => tx.insert(schema.users).values({ email: `m${n}@acme.test`, id: `user_${n}` }),
      platform,
    );

  it('lets members join until the limit and refuses the next one', async () => {
    await setLimit(3);
    for (const n of [1, 2, 3]) await join(n);
    await expect(join(4)).rejects.toBeInstanceOf(SeatLimitError);
    expect(await members()).toBe(3);
  });

  it('puts no limit on a tenant without one', async () => {
    await setLimit(null);
    for (const n of [1, 2, 3, 4, 5]) await join(n);
    expect(await members()).toBe(5);
  });

  it('takes a changed limit at once, and a limit below the members only stops new ones', async () => {
    await setLimit(null);
    for (const n of [1, 2, 3]) await join(n);
    await setLimit(1);
    await expect(join(4)).rejects.toBeInstanceOf(SeatLimitError);
    expect(await members()).toBe(3);
    await setLimit(4);
    await join(4);
    expect(await members()).toBe(4);
  });

  it('never exceeds the limit under concurrent creators', async () => {
    await setLimit(4);
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, n) => join(n)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    for (const result of results.filter((r) => r.status === 'rejected'))
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(SeatLimitError);
    expect(await members()).toBe(4);
  });

  it('takes the lock Admin takes: a holder of the seat lock stops a creator until it commits', async () => {
    await setLimit(5);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('seat:' || $1::text))`, [TENANT]);
      let finished = false;
      const pending = join(1).finally(() => (finished = true));
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(finished).toBe(false);
      await holder.query('COMMIT');
      await pending;
      expect(await members()).toBe(1);
    } finally {
      holder.release();
    }
  });

  it('serves a caller that already has a transaction, and leaves the lock to its end', async () => {
    await setLimit(1);
    await db.transaction(async (tx) => {
      await assertSeatAvailable(tx, TENANT, platform);
      await tx.insert(schema.users).values({ email: 'm1@acme.test', id: 'user_1' });
    });
    await expect(
      db.transaction((tx) => assertSeatAvailable(tx, TENANT, platform)),
    ).rejects.toBeInstanceOf(SeatLimitError);
  });

  it('refuses when the tenant has no directory row: the limit is unknown', async () => {
    await expect(
      db.transaction((tx) => assertSeatAvailable(tx, 'unknown-tenant', platform)),
    ).rejects.toThrow('TENANT_NOT_FOUND');
  });
});
