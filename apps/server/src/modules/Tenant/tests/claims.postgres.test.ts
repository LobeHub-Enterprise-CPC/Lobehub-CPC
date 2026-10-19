// @vitest-environment node
import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForTenantClaims } from '../postgresClaims';

// Must point to an explicitly created disposable test container, never .env DATABASE_URL.
const configured = process.env.TENANT_CLAIMS_TEST_URL;
describe.skipIf(!configured)('process lease stop confirmation (disposable PostgreSQL)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    const url = new URL(configured!);
    if (url.hostname !== '127.0.0.1' || ['5432', '5433', '55441'].includes(url.port))
      throw new Error('A disposable PostgreSQL container on a dedicated loopback port is required');
    pool = new Pool({ connectionString: configured, max: 1 });
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: path.resolve('packages/database/migrations/platform') });
    await migrate(db, { migrationsFolder: path.resolve('packages/database/migrations/platform') });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('ignores expired leases, blocks on missing/old generation receipts, and waits for live request drain', async () => {
    await pool.query(
      "INSERT INTO tenant_lifecycle (tenant_id,desired_state,accepted_version) VALUES ('lease-test','frozen',2)",
    );
    await pool.query(
      "INSERT INTO tenant_runtime_process (process_id,lease_expires_at) VALUES ('crashed',now()-interval '1 second')",
    );
    await expect(waitForTenantClaims('lease-test', 0, db as never)).resolves.toBeUndefined();
    await pool.query(
      "INSERT INTO tenant_runtime_process (process_id,lease_expires_at,drained_generations) VALUES ('live',now()+interval '1 minute','{\"lease-test\":1}')",
    );
    await expect(waitForTenantClaims('lease-test', 0, db as never)).rejects.toThrow(
      'LIFECYCLE_STOP_UNCONFIRMED',
    );
    const waiting = waitForTenantClaims('lease-test', 2000, db as never);
    await pool.query(
      "UPDATE tenant_runtime_process SET drained_generations='{\"lease-test\":2}' WHERE process_id='live'",
    );
    await expect(waiting).resolves.toBeUndefined();
  });
});
