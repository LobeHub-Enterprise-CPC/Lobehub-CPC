import {
  createTenantSchemaPool,
  type TenantPoolConfig,
  TenantPoolManager,
} from '@lobechat/database/tenant';
import { Pool } from 'pg';

const run = async () => {
  const oldUrl = new URL(process.env.DATABASE_TEST_URL!);
  const nextUrl = new URL(process.env.CLIENT_DISCONNECT_NEW_URL!);
  if (oldUrl.host !== nextUrl.host || oldUrl.pathname !== nextUrl.pathname) {
    throw new Error('Disconnect fixture must use one isolated database');
  }
  const schemaName = 'tenant_f1f1014f1f1014f1f1014f1f1';
  const tenantId = 'client-disconnect-fixture';
  const extra = process.argv[2] === 'idle' ? { idle_in_transaction_session_timeout: 300 } : {};
  const configFor = (url: URL, connectionVersion: number): TenantPoolConfig => ({
    connection: {
      database: url.pathname.slice(1),
      host: url.hostname,
      password: decodeURIComponent(url.password),
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
    },
    connectionVersion,
    purpose: 'request',
    schemaName,
    tenantId,
  });
  const manager = new TenantPoolManager({
    maxConnectionsPerPool: 1,
    createPool: (config) => new Pool({ ...config, ...extra }),
  });
  let current = configFor(oldUrl, 1);
  const facade = createTenantSchemaPool(() => manager.acquire(current), schemaName, tenantId);
  const handle = await facade.connect();
  await handle.query('BEGIN');
  const original = await handle.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  process.stdout.write(JSON.stringify({ backendPid: original.rows[0].pid, ready: true }) + '\n');
  // The fixture adds no listener to the borrowed Client: production must own it.
  await new Promise((resolve) => {
    setTimeout(resolve, 1000);
  });
  let refused = false;
  try {
    await handle.query('SELECT 1');
  } catch {
    refused = true;
  }
  handle.release();
  current = configFor(nextUrl, 2);
  const recovered = await facade.query<{ user: string; pid: number }>(
    'SELECT current_user AS user, pg_backend_pid() AS pid',
  );
  await manager.closeAll();
  const result = {
    survived: true,
    deadHandleRefused: refused,
    reconnectedWithNewCredential: recovered.rows[0].user === decodeURIComponent(nextUrl.username),
    newBackend: recovered.rows[0].pid !== original.rows[0].pid,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!Object.values(result).every(Boolean)) process.exitCode = 2;
};
void run().catch(() => {
  process.stderr.write('DISCONNECT_FIXTURE_FAILED\n');
  process.exitCode = 1;
});
