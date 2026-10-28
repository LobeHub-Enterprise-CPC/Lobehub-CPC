import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { expect } from 'vitest';

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export const checkBorrowedClientDisconnect = async (
  observer: Pick<Pool, 'query'>,
  connectionString: string,
  mode: 'terminate' | 'idle',
  fixture: string,
  cwd: string,
) => {
  const url = new URL(connectionString);
  if (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5433') {
    throw new Error('Refused persistent development PostgreSQL; use an isolated DATABASE_TEST_URL');
  }
  const suffix = randomUUID().replaceAll('-', '');
  const oldUser = `disconnect_old_${suffix}`;
  const nextUser = `disconnect_new_${suffix}`;
  const oldPassword = randomUUID();
  const nextPassword = randomUUID();
  const roles = [oldUser, nextUser];
  try {
    await observer.query(`CREATE ROLE ${quote(oldUser)} LOGIN PASSWORD '${oldPassword}'`);
    await observer.query(`CREATE ROLE ${quote(nextUser)} LOGIN PASSWORD '${nextPassword}'`);
    for (const role of roles) {
      await observer.query(
        `GRANT CONNECT ON DATABASE ${quote(url.pathname.slice(1))} TO ${quote(role)}`,
      );
    }
    const oldUrl = new URL(url);
    oldUrl.username = oldUser;
    oldUrl.password = oldPassword;
    const nextUrl = new URL(url);
    nextUrl.username = nextUser;
    nextUrl.password = nextPassword;
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode], {
      cwd,
      env: {
        ...process.env,
        CLIENT_DISCONNECT_NEW_URL: nextUrl.href,
        DATABASE_TEST_URL: oldUrl.href,
        NODE_OPTIONS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    const records: Record<string, unknown>[] = [];
    let termination: Promise<unknown> | undefined;
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.startsWith('{')) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        records.push(record);
        if (record.ready && mode === 'terminate') {
          // Only this test's borrowed backend in its own fixture DB may be terminated.
          termination = observer.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND usename=$3',
            [record.backendPid, url.pathname.slice(1), oldUser],
          );
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      await termination;
      expect({ exit, unhandledError: stderr.includes("Unhandled 'error' event") }).toEqual({
        exit: 0,
        unhandledError: false,
      });
      expect(records).toContainEqual(
        expect.objectContaining({
          deadHandleRefused: true,
          newBackend: true,
          reconnectedWithNewCredential: true,
          survived: true,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    for (const role of roles) {
      await observer.query(
        `REVOKE CONNECT ON DATABASE ${quote(url.pathname.slice(1))} FROM ${quote(role)}`,
      );
      await observer.query(`DROP ROLE IF EXISTS ${quote(role)}`);
    }
  }
};
