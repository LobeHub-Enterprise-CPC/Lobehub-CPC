// @vitest-environment node
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresControlPlaneRepository } from '@/server/services/tenantControlPlane/postgresRepository';
import { TenantControlPlaneService } from '@/server/services/tenantControlPlane/service';

import { waitForTenantClaims } from '../postgresClaims';

const configured = process.env.TENANT_CLAIMS_TEST_URL;

describe.skipIf(!configured)('strict stop across real OS processes and PostgreSQL', () => {
  let maintenance: Pool;
  let created = false;
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let url: string;
  let service: TenantControlPlaneService;
  const databaseName = `strict_stop_${randomUUID().replaceAll('-', '')}`;
  const children: ChildProcessWithoutNullStreams[] = [];
  const messages = new Map<ChildProcessWithoutNullStreams, any[]>();
  const migrationFolder = path.resolve('packages/database/migrations/platform');

  const eventually = async (check: () => Promise<boolean>, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('condition not observed');
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  const worker = () => {
    const child = spawn('bun', ['scripts/tenantRuntime/claimsWorker.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    const events: any[] = [];
    messages.set(child, events);
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        /* Runtime diagnostics are not protocol messages. */
      }
    });
    child.stderr.on('data', () => {});
    return child;
  };
  const command = async (
    child: ChildProcessWithoutNullStreams,
    action: string,
    tenantId: string,
  ) => {
    const events = messages.get(child)!;
    const start = events.length;
    child.stdin.write(JSON.stringify({ action, tenantId }) + '\n');
    await eventually(async () =>
      events.slice(start).some((e) => e.event === action || e.event === 'error'),
    );
    return events.slice(start).find((e) => e.event === action || e.event === 'error');
  };
  const count = async (tenantId: string) =>
    Number(
      (await pool.query('SELECT count(*) FROM tenant_runtime_claim WHERE tenant_id=$1', [tenantId]))
        .rows[0].count,
    );
  const seed = async (tenantId: string) => {
    await pool.query(
      `INSERT INTO tenant_directory (tenant_id,slug,name,host,port,database,schema_name,schema_version,runtime_username,runtime_secret,owner_username,owner_secret,connection_version,credential_bundle_version,mode,deployment_ref,tls,status)
      VALUES ($1,$1,$1,'unused',5432,'unused',$1,1,'unused','unused','unused','unused',1,1,'shared_schema','test','{"enabled":false,"rejectUnauthorized":false}','active')`,
      [tenantId],
    );
    await pool.query(
      "INSERT INTO tenant_lifecycle(tenant_id,accepted_version,applied_version,desired_state) VALUES($1,1,1,'active')",
      [tenantId],
    );
  };
  const freeze = async (tenantId: string) =>
    service.receiveLifecycle({
      tenantId,
      eventId: `freeze-${tenantId}`,
      version: 2,
      desiredState: 'frozen',
      freezeReasons: ['manual'],
      expiresAt: null,
      occurredAt: new Date().toISOString(),
    });
  const execute = (tenantId: string) =>
    service.executeLifecycle(tenantId, `freeze-${tenantId}`, {
      invalidateCaches: async () => {},
      closeRealtime: async () => {},
      stopQueue: async () => {},
      resumeQueue: async () => {},
      drainTransactions: () => waitForTenantClaims(tenantId, 100, db as any),
    });
  beforeAll(async () => {
    const base = new URL(configured!);
    if (
      !['postgres:', 'postgresql:'].includes(base.protocol) ||
      !base.hostname ||
      base.pathname === '/'
    )
      throw new Error(
        'TENANT_CLAIMS_TEST_URL must explicitly name a dedicated PostgreSQL maintenance database',
      );
    maintenance = new Pool({ connectionString: base.toString() });
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    base.pathname = `/${databaseName}`;
    url = base.toString();
    pool = new Pool({ connectionString: url });
    db = drizzle(pool);
    service = new TenantControlPlaneService({
      repository: new PostgresControlPlaneRepository(db as any),
      database: {} as any,
      isRegistrableSlug: () => true,
    });
    // Historical upgrade: real previous migration + data, then final migration twice.
    const migrations = readMigrationFiles({ migrationsFolder: migrationFolder });
    await (db as any).dialect.migrate(migrations.slice(0, -1), (db as any).session, {
      migrationsSchema: 'drizzle',
    });
    await seed('historical');
    await migrate(db, { migrationsFolder: migrationFolder });
    await migrate(db, { migrationsFolder: migrationFolder });
    expect(
      (await pool.query("SELECT name FROM tenant_directory WHERE tenant_id='historical'")).rows[0]
        .name,
    ).toBe('historical');
  }, 30000);
  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGCONT');
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    await pool?.end();
    if (maintenance) {
      if (created) await maintenance.query(`DROP DATABASE "${databaseName}"`);
      await maintenance.end();
    }
  });

  it('installs the complete platform migration chain on an empty database and repeats safely', async () => {
    const emptyName = `${databaseName}_empty`;
    await maintenance.query(`CREATE DATABASE "${emptyName}"`);
    const emptyUrl = new URL(url);
    emptyUrl.pathname = `/${emptyName}`;
    const emptyPool = new Pool({ connectionString: emptyUrl.toString() });
    try {
      const emptyDb = drizzle(emptyPool);
      await migrate(emptyDb, { migrationsFolder: migrationFolder });
      await migrate(emptyDb, { migrationsFolder: migrationFolder });
      expect(
        (await emptyPool.query('SELECT count(*) FROM tenant_runtime_claim')).rows[0].count,
      ).toBe('0');
    } finally {
      await emptyPool.end();
      await maintenance.query(`DROP DATABASE "${emptyName}"`);
    }
  });

  it('refuses to certify an empty table before legacy-worker cutover', async () => {
    await expect(waitForTenantClaims('historical', 50, db as any)).rejects.toThrow(
      'CUTOVER_REQUIRED',
    );
    await pool.query(
      "INSERT INTO tenant_runtime_cutover(id,enforced_at,evidence,build_ref) VALUES('strict-stop',now(),'isolated fixture contains only owned new workers','test')",
    );
  });

  it('retains delayed work in two processes, rejects new work, and leaves another tenant running', async () => {
    await seed('delayed');
    await seed('other');
    const a = worker(),
      b = worker();
    expect(await command(a, 'start', 'delayed')).toMatchObject({ event: 'start' });
    expect(await command(b, 'start', 'delayed')).toMatchObject({ event: 'start' });
    expect(await command(b, 'start', 'other')).toMatchObject({ event: 'start' });
    expect(await count('delayed')).toBe(2);
    await freeze('delayed');
    await eventually(async () => messages.get(a)!.some((e) => e.event === 'cancel'));
    await expect(waitForTenantClaims('delayed', 100, db as any)).rejects.toThrow('UNCONFIRMED');
    expect(await count('other')).toBe(1);
    expect(await execute('delayed')).toMatchObject({ status: 'failed', appliedVersion: 1 });
    const fresh = worker();
    expect(await command(fresh, 'start', 'delayed')).toMatchObject({
      event: 'error',
      code: 'TENANT_FROZEN',
    });
    await command(a, 'finish', 'delayed');
    await eventually(async () => (await count('delayed')) === 1);
    await expect(waitForTenantClaims('delayed', 100, db as any)).rejects.toThrow('UNCONFIRMED');
    await command(b, 'finish', 'delayed');
    await waitForTenantClaims('delayed', 3000, db as any);
    expect(await execute('delayed')).toMatchObject({ status: 'applied', appliedVersion: 2 });
    await command(b, 'finish', 'other');
  }, 20000);

  it('admits renewed expiry claims while retaining manual, security and offline gates', async () => {
    const child = worker();
    const cases = [
      { id: 'renewed-null', reasons: ['expired'], expires: null, state: 'active', code: null },
      {
        id: 'renewed-future',
        reasons: ['expired'],
        expires: '2099-01-01',
        state: 'active',
        code: null,
      },
      {
        id: 'expired-past',
        reasons: ['expired'],
        expires: '2000-01-01',
        state: 'active',
        code: 'TENANT_EXPIRED',
      },
      {
        id: 'renewed-manual',
        reasons: ['expired', 'manual'],
        expires: null,
        state: 'active',
        code: 'TENANT_FROZEN',
      },
      {
        id: 'renewed-security',
        reasons: ['expired', 'security'],
        expires: null,
        state: 'active',
        code: 'TENANT_FROZEN',
      },
      {
        id: 'renewed-offline',
        reasons: ['expired'],
        expires: null,
        state: 'offline',
        code: 'TENANT_OFFLINE',
      },
    ];
    for (const row of cases) {
      await seed(row.id);
      await pool.query(
        'UPDATE tenant_lifecycle SET freeze_reasons=$2, expires_at=$3, desired_state=$4 WHERE tenant_id=$1',
        [row.id, JSON.stringify(row.reasons), row.expires, row.state],
      );
      expect(await command(child, 'start', row.id)).toMatchObject(
        row.code ? { event: 'error', code: row.code } : { event: 'start' },
      );
      if (!row.code) await command(child, 'finish', row.id);
    }
  });

  it('keeps remote jobs pending independently of process retirement', async () => {
    await seed('remote');
    await pool.query(
      "INSERT INTO tenant_runtime_external_work(work_id,tenant_id,kind,handle) VALUES('video:remote','remote','video','provider-job')",
    );
    await freeze('remote');
    expect(await execute('remote')).toMatchObject({ status: 'failed', appliedVersion: 1 });
    // This fixture stands in for an independently verified terminal provider response.
    await pool.query(
      'UPDATE tenant_runtime_external_work SET completed_at=now(), receipt=\'{"source":"test-provider-terminal"}\' WHERE work_id=\'video:remote\'',
    );
    expect(await execute('remote')).toMatchObject({ status: 'applied', appliedVersion: 2 });
  });

  it('never converts a paused or crashed worker into a successful receipt', async () => {
    await seed('paused');
    const child = worker();
    await command(child, 'start', 'paused');
    child.kill('SIGSTOP');
    await freeze('paused');
    await pool.query("UPDATE tenant_runtime_process SET heartbeat_at=now()-interval '1 day'");
    await expect(waitForTenantClaims('paused', 100, db as any)).rejects.toThrow('UNCONFIRMED');
    expect(await count('paused')).toBe(1);
    const processId = (
      await pool.query('SELECT process_id FROM tenant_runtime_process WHERE pid=$1', [child.pid])
    ).rows[0].process_id;
    const retire = () =>
      spawnSync('bun', ['scripts/tenantRuntime/manage.ts', 'retire', 'lobehub', processId], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
      });
    const refused = retire();
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('RETIRE_PROCESS_STILL_ALIVE');
    child.kill('SIGCONT');
    child.kill('SIGKILL');
    await once(child, 'exit');
    await expect(waitForTenantClaims('paused', 100, db as any)).rejects.toThrow('UNCONFIRMED');
    expect(await count('paused')).toBe(1);
    expect(await execute('paused')).toMatchObject({ status: 'failed', appliedVersion: 1 });
    expect(retire().status).toBe(0);
    expect(await execute('paused')).toMatchObject({ status: 'applied', appliedVersion: 2 });
  }, 10000);
});
