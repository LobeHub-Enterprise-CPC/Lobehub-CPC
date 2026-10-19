// @vitest-environment node
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';

import { tenantLeaseBlocker } from './processLease';
import { tenantRuntimeProcess } from './schemas';

const migrationsFolder = path.resolve(__dirname, '../../migrations/platform');

describe('platform process lease migration', () => {
  it('installs the fresh platform chain and reruns without changing history', async () => {
    const pg = new PGlite();
    try {
      const db = drizzle(pg);
      await migrate(db, { migrationsFolder });
      await migrate(db, { migrationsFolder });
      const { rows } = await pg.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations',
      );
      expect(rows[0].count).toBe(readMigrationFiles({ migrationsFolder }).length);
      await pg.exec("INSERT INTO tenant_runtime_process(process_id) VALUES ('fresh')");
      const result = await pg.query<{ drained_generations: unknown; expired: boolean }>(
        'SELECT drained_generations, lease_expires_at <= now() AS expired FROM tenant_runtime_process',
      );
      expect(result.rows).toEqual([{ drained_generations: {}, expired: true }]);
    } finally {
      await pg.close();
    }
  });

  it('ignores crashed expired processes and requires each live lease to acknowledge the exact drained generation', async () => {
    const pg = new PGlite();
    try {
      const db = drizzle(pg);
      await migrate(db, { migrationsFolder });
      await pg.exec(`
        INSERT INTO tenant_lifecycle(tenant_id,desired_state,accepted_version) VALUES ('t','frozen',2);
        INSERT INTO tenant_runtime_process(process_id,lease_expires_at,drained_generations)
        VALUES ('crashed',now()-interval '1 second','{}'),
               ('live-inflight',now()+interval '1 minute','{}'),
               ('old-generation',now()+interval '1 minute','{"t":1}'),
               ('drained',now()+interval '1 minute','{"t":2}');
      `);
      const blockers = () =>
        db
          .select({ id: tenantRuntimeProcess.processId })
          .from(tenantRuntimeProcess)
          .where(tenantLeaseBlocker('t'));
      expect((await blockers()).map((row) => row.id).sort()).toEqual([
        'live-inflight',
        'old-generation',
      ]);
      await pg.exec(
        `UPDATE tenant_runtime_process SET drained_generations='{"t":2}' WHERE process_id IN ('live-inflight','old-generation')`,
      );
      expect(await blockers()).toEqual([]);
      // A subsequent Console event must invalidate all previous acknowledgements.
      await pg.exec("UPDATE tenant_lifecycle SET accepted_version=3 WHERE tenant_id='t'");
      expect(await blockers()).toHaveLength(3);
      await pg.exec("UPDATE tenant_runtime_process SET lease_expires_at=now()-interval '1 second'");
      expect(await blockers()).toEqual([]);
    } finally {
      await pg.close();
    }
  });

  it('upgrades historical process and claim rows and preserves external work and lifecycle state', async () => {
    const pg = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      for (const migration of migrations.slice(0, -1))
        for (const sql of migration.sql) await pg.exec(sql);
      await pg.exec(`
        INSERT INTO tenant_runtime_process(process_id,host,pid) VALUES ('old','host',123);
        INSERT INTO tenant_runtime_claim(tenant_id,process_id,claim_token,claimed_version) VALUES ('t','old','token',1);
        INSERT INTO tenant_lifecycle(tenant_id,desired_state,accepted_version) VALUES ('t','frozen',2);
        INSERT INTO tenant_runtime_external_work(work_id,tenant_id,kind) VALUES ('external','t','video');
      `);
      for (const sql of migrations.at(-1)!.sql) await pg.exec(sql);
      const result = await pg.query<{ expired: boolean; drained_generations: unknown }>(
        'SELECT lease_expires_at <= now() AS expired, drained_generations FROM tenant_runtime_process',
      );
      expect(result.rows).toEqual([{ expired: true, drained_generations: {} }]);
      expect((await pg.query('SELECT * FROM tenant_runtime_external_work')).rows).toHaveLength(1);
      expect((await pg.query('SELECT accepted_version FROM tenant_lifecycle')).rows).toEqual([
        { accepted_version: 2 },
      ]);
    } finally {
      await pg.close();
    }
  });
});
