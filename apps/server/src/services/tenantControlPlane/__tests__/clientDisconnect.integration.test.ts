// @vitest-environment node
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { checkBorrowedClientDisconnect } from './clientDisconnectCheck.fixture';

const configured = process.env.DATABASE_TEST_URL;
const databaseName = `lobe_client_disconnect_${randomUUID().replaceAll('-', '')}`;
const repoRoot = path.resolve(__dirname, '../../../../../..');

describe.skipIf(!configured)('borrowed tenant client PostgreSQL disconnection', () => {
  let admin: Client;
  let connectionString: string;
  beforeAll(async () => {
    const maintenance = new URL(configured!);
    if (['localhost', '127.0.0.1'].includes(maintenance.hostname) && maintenance.port === '5433') {
      throw new Error('Refused persistent development database');
    }
    admin = new Client({ connectionString: maintenance.href });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname = `/${databaseName}`;
    connectionString = maintenance.href;
  });
  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  });
  it.each(['terminate', 'idle'] as const)(
    'survives %s and reconnects with a new credential',
    async (mode) => {
      await checkBorrowedClientDisconnect(
        admin,
        connectionString,
        mode,
        path.join(__dirname, 'clientDisconnectChild.fixture.ts'),
        repoRoot,
      );
    },
    45_000,
  );
});
