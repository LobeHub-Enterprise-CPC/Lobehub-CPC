import { describe, expect, it, vi } from 'vitest';

import { TenantDatabaseError } from './errors';
import type { TenantPoolLease } from './pool';
import { createTenantSchemaPool } from './session';

const SCHEMA = 'tenant_0123456789abcdef01234567';

/** A pooled connection that records every statement sent to it. */
const fakeLease = () => {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (query: unknown) => {
      statements.push(typeof query === 'string' ? query : String((query as any)?.text));
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const lease = { pool: { connect: async () => client }, release: vi.fn() };
  return { client, lease: lease as unknown as TenantPoolLease, statements };
};

/** Admits the early check, refuses the one made after the drain lock. */
const refusedAfterLock = () => {
  const refusal = new Error('TENANT_FROZEN');
  const admit = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(refusal);
  return { admit, refusal };
};

const kinds = (statements: string[]) =>
  statements.map((s) => (s.includes('pg_advisory_xact_lock_shared') ? 'PRELUDE' : s));

describe('createTenantSchemaPool', () => {
  it('rolls back and returns the connection once when a transaction is refused after BEGIN', async () => {
    const { client, lease, statements } = fakeLease();
    const { admit, refusal } = refusedAfterLock();
    const pool = createTenantSchemaPool(() => lease, SCHEMA, 't-1', admit);

    // Drizzle's transaction path: connect, then BEGIN outside its try/finally.
    const handle = await pool.connect();
    await expect(handle.query('begin')).rejects.toBe(refusal);

    expect(kinds(statements)).toEqual(['begin', 'PRELUDE', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);

    // The connection may already serve someone else: nothing more reaches it.
    await expect(handle.query('rollback')).rejects.toBeInstanceOf(TenantDatabaseError);
    handle.release();
    expect(kinds(statements)).toEqual(['begin', 'PRELUDE', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('never runs the statement or a second ROLLBACK for a refused standalone statement', async () => {
    const { client, lease, statements } = fakeLease();
    const { admit, refusal } = refusedAfterLock();
    const pool = createTenantSchemaPool(() => lease, SCHEMA, 't-1', admit);

    await expect(pool.query('INSERT INTO notes VALUES (1)')).rejects.toBe(refusal);

    expect(kinds(statements)).toEqual(['BEGIN', 'PRELUDE', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('discards a connection whose ROLLBACK failed', async () => {
    const { client, lease } = fakeLease();
    const broken = new Error('connection lost');
    client.query.mockImplementation(async (query: unknown) => {
      if (query === 'ROLLBACK') throw broken;
      return { rows: [] };
    });
    const { admit, refusal } = refusedAfterLock();
    const pool = createTenantSchemaPool(() => lease, SCHEMA, 't-1', admit);

    await expect(pool.query('SELECT 1')).rejects.toBe(refusal);
    expect(client.release).toHaveBeenCalledWith(broken);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('runs an admitted standalone statement inside the guarded transaction', async () => {
    const { client, lease, statements } = fakeLease();
    const admit = vi.fn().mockResolvedValue(undefined);
    const pool = createTenantSchemaPool(() => lease, SCHEMA, 't-1', admit);

    await pool.query('SELECT 1');

    expect(kinds(statements)).toEqual(['BEGIN', 'PRELUDE', 'SELECT 1', 'COMMIT']);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
